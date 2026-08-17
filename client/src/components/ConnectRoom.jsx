import React, { useState, useEffect, useRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';
import { 
  Copy, 
  Check, 
  Send, 
  Lock, 
  Sparkles, 
  Zap, 
  RefreshCw, 
  Server, 
  ChevronDown, 
  ChevronUp, 
  KeyRound, 
  QrCode, 
  FileCode,
  Flame,
  Clock,
  Trash2,
  Info,
  Paperclip,
  File,
  Download,
  UploadCloud,
  X,
  FileText,
  CheckCircle2,
  Loader2,
  Camera,
  FileImage,
  UserCheck,
  ShieldCheck,
  HelpCircle,
  MoreHorizontal,
  MoreVertical,
  ChevronLeft,
  Languages,
  CheckCheck,
  Heart
} from 'lucide-react';
import { PeerSession, getDefaultSignalingUrl } from '../utils/webrtc';
import { validatePeerIdentityPayload } from '../utils/crypto';
import { 
  DEFAULT_TTL_SECONDS, 
  DEFAULT_FILE_TTL_SECONDS,
  FILE_TTL_OPTIONS,
  BURN_ON_READ_DELAY_SECONDS, 
  BACKGROUND_BLUR_PURGE_TIMEOUT_MS,
  getRemainingSeconds, 
  isMessageExpired,
  revokeFileBlobUrl 
} from '../utils/ephemeral';
import { formatFileSize, MAX_FILE_SIZE } from '../utils/fileTransfer';

const SESSION_STORAGE_PEER_KEY = 'covert_last_paired_peer';

export default function ConnectRoom({ 
  myIdentity, 
  verifiedPeer, 
  onSetVerifiedPeer, 
  onShowToast 
}) {
  const [status, setStatus] = useState('idle'); // 'idle' | 'creating' | 'waiting' | 'joining' | 'connecting' | 'connected' | 'disconnected' | 'error'
  const [statusDetails, setStatusDetails] = useState(null);
  const [roomCode, setRoomCode] = useState('');
  const [joinInput, setJoinInput] = useState('');
  const [copiedCode, setCopiedCode] = useState(false);
  const [messages, setMessages] = useState([]); // VOLATILE RAM INVARIANT
  const [inputText, setInputText] = useState('');
  const [burnOnReadEnabled, setBurnOnReadEnabled] = useState(false);
  const [customServerUrl, setCustomServerUrl] = useState(getDefaultSignalingUrl());
  const [showServerConfig, setShowServerConfig] = useState(false);
  const [rawPeerJsonInput, setRawPeerJsonInput] = useState('');
  const [showManualPeerInput, setShowManualPeerInput] = useState(false);
  const [currentTime, setCurrentTime] = useState(Date.now());
  const [showSecurityModal, setShowSecurityModal] = useState(false);
  const [showOptionsMenu, setShowOptionsMenu] = useState(false);

  // Pairing States
  const [isJoinScannerOpen, setIsJoinScannerOpen] = useState(false);
  const [cameraError, setCameraError] = useState(null);
  const [isProcessingFile, setIsProcessingFile] = useState(false);
  const [savedPeer, setSavedPeer] = useState(() => {
    try {
      const stored = sessionStorage.getItem(SESSION_STORAGE_PEER_KEY);
      return stored ? JSON.parse(stored) : null;
    } catch {
      return null;
    }
  });

  // File Sharing States
  const [attachedFile, setAttachedFile] = useState(null);
  const [fileTtlSeconds, setFileTtlSeconds] = useState(DEFAULT_FILE_TTL_SECONDS);
  const [fileBurnOnRead, setFileBurnOnRead] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [isSendingFile, setIsSendingFile] = useState(false);

  // Connection Quality State ('direct' | 'relay' | null)
  const [connectionType, setConnectionType] = useState(null);

  const sessionRef = useRef(null);
  const messagesEndRef = useRef(null);
  const blurTimerRef = useRef(null);
  const fileInputRef = useRef(null);
  const qrFileInputRef = useRef(null);
  const html5QrScannerRef = useRef(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const scannerContainerId = 'covert-join-qr-reader';

  const saveSessionPeer = (peer) => {
    if (!peer) return;
    try {
      sessionStorage.setItem(SESSION_STORAGE_PEER_KEY, JSON.stringify(peer));
      setSavedPeer(peer);
    } catch {}
  };

  const clearSessionPeer = () => {
    try {
      sessionStorage.removeItem(SESSION_STORAGE_PEER_KEY);
      setSavedPeer(null);
    } catch {}
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    if (status !== 'connected') {
      setConnectionType(null);
      return;
    }

    let isMounted = true;
    const checkType = async () => {
      if (sessionRef.current) {
        const type = await sessionRef.current.getConnectionType();
        if (isMounted && type && type !== 'unknown') {
          setConnectionType(type);
        }
      }
    };

    checkType();
    const timer = setTimeout(checkType, 1500);

    return () => {
      isMounted = false;
      clearTimeout(timer);
    };
  }, [status]);

  // 1-Second Ticking & Ephemeral Garbage Collection Loop
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      setCurrentTime(now);

      setMessages((prev) => {
        const expired = prev.filter((msg) => isMessageExpired(msg, now));
        if (expired.length > 0) {
          expired.forEach(revokeFileBlobUrl);
          return prev.filter((msg) => !isMessageExpired(msg, now));
        }
        return prev;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  // Burn-on-Read: Activate countdown when recipient first renders the message
  useEffect(() => {
    setMessages((prev) => {
      let updated = false;
      const now = Date.now();

      const next = prev.map((msg) => {
        if (msg.sender === 'peer' && msg.burnOnRead && !msg.burnDeadline) {
          if (!msg.type || msg.type === 'text' || (msg.type === 'file' && msg.status === 'completed')) {
            updated = true;
            return {
              ...msg,
              renderedAt: now,
              burnDeadline: now + (msg.burnDelay || BURN_ON_READ_DELAY_SECONDS) * 1000,
            };
          }
        }
        return msg;
      });

      return updated ? next : prev;
    });
  }, [messages.length]);

  // Anti-Persistence Guard: Window Blur & Tab Close Auto-Purge
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        blurTimerRef.current = setTimeout(() => {
          if (sessionRef.current) {
            sessionRef.current.cleanup(true);
          }
          messagesRef.current.forEach(revokeFileBlobUrl);
          setMessages([]);
          setAttachedFile(null);
          setStatus('disconnected');
          setStatusDetails({
            message: 'Session wiped: Inactive for over 30 seconds.',
          });
        }, BACKGROUND_BLUR_PURGE_TIMEOUT_MS);
      } else {
        if (blurTimerRef.current) {
          clearTimeout(blurTimerRef.current);
          blurTimerRef.current = null;
        }
      }
    };

    const handleBeforeUnload = () => {
      if (sessionRef.current) {
        sessionRef.current.cleanup(false);
      }
      messagesRef.current.forEach(revokeFileBlobUrl);
      setMessages([]);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      if (blurTimerRef.current) {
        clearTimeout(blurTimerRef.current);
      }
      if (sessionRef.current) {
        sessionRef.current.cleanup();
      }
      stopCameraScanner();
      messagesRef.current.forEach(revokeFileBlobUrl);
    };
  }, []);

  const stopCameraScanner = async () => {
    if (html5QrScannerRef.current) {
      try {
        if (html5QrScannerRef.current.isScanning) {
          await html5QrScannerRef.current.stop();
        }
        await html5QrScannerRef.current.clear();
      } catch {}
      html5QrScannerRef.current = null;
    }
    setIsJoinScannerOpen(false);
    setCameraError(null);
  };

  const startCameraScanner = async () => {
    setIsJoinScannerOpen(true);
    setCameraError(null);

    setTimeout(async () => {
      try {
        if (html5QrScannerRef.current) {
          await stopCameraScanner();
        }

        const scanner = new Html5Qrcode(scannerContainerId, {
          formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
          verbose: false,
        });
        html5QrScannerRef.current = scanner;

        await scanner.start(
          { facingMode: 'environment' },
          { fps: 12, qrbox: { width: 240, height: 240 }, aspectRatio: 1.0 },
          (decodedText) => handleQrScanSuccess(decodedText),
          () => {}
        );
      } catch (err) {
        console.warn('Camera error:', err);
        setCameraError(
          err.name === 'NotAllowedError'
            ? 'Camera permission denied. Please allow camera access in browser settings.'
            : 'Unable to access camera. You can also upload a QR code image.'
        );
      }
    }, 100);
  };

  const handleQrScanSuccess = async (decodedText) => {
    try {
      const validation = await validatePeerIdentityPayload(decodedText);
      if (!validation.valid || !validation.peerIdentity) {
        onShowToast(validation.error || 'Invalid QR code', 'error');
        return;
      }

      const peer = validation.peerIdentity;
      onSetVerifiedPeer(peer);
      saveSessionPeer(peer);
      await stopCameraScanner();

      if (peer.room) {
        onShowToast(`Connecting to room ${peer.room}...`, 'success');
        await handleDirectJoinRoom(peer.room, peer);
      } else {
        onShowToast('Peer verified! Enter room code to connect.', 'info');
      }
    } catch (err) {
      onShowToast(`Scan error: ${err.message}`, 'error');
    }
  };

  const handleQrFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsProcessingFile(true);
    try {
      const tempScanner = new Html5Qrcode('covert-file-temp-scanner', {
        formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
        verbose: false,
      });
      const decodedText = await tempScanner.scanFile(file, true);
      await tempScanner.clear();
      await handleQrScanSuccess(decodedText);
    } catch (err) {
      onShowToast('Could not find a valid QR code in image.', 'warning');
    } finally {
      setIsProcessingFile(false);
      if (qrFileInputRef.current) qrFileInputRef.current.value = '';
    }
  };

  const handleManualPeerValidate = async (e) => {
    e?.preventDefault();
    if (!rawPeerJsonInput.trim()) return;

    try {
      const res = await validatePeerIdentityPayload(rawPeerJsonInput.trim());
      if (res.valid && res.peerIdentity) {
        onSetVerifiedPeer(res.peerIdentity);
        saveSessionPeer(res.peerIdentity);
        setShowManualPeerInput(false);
        setRawPeerJsonInput('');
        onShowToast('Peer identity verified!', 'success');
        if (res.peerIdentity.room) {
          await handleDirectJoinRoom(res.peerIdentity.room, res.peerIdentity);
        }
      } else {
        onShowToast(res.error || 'Invalid peer identity payload', 'error');
      }
    } catch (err) {
      onShowToast(`Failed to parse identity: ${err.message}`, 'error');
    }
  };

  const handleIncomingMessageOrFile = (messageData) => {
    setMessages((prev) => {
      const existingIndex = prev.findIndex((m) => m.id === messageData.id);
      if (existingIndex >= 0) {
        const next = [...prev];
        next[existingIndex] = { ...next[existingIndex], ...messageData };
        return next;
      } else {
        return [...prev, messageData];
      }
    });
  };

  const initSession = (peerToUse = verifiedPeer) => {
    if (sessionRef.current) {
      sessionRef.current.cleanup(false);
    }

    const session = new PeerSession(
      {
        onStatusChange: (newStatus, details) => {
          setStatus(newStatus);
          setStatusDetails(details || null);

          if (newStatus === 'connected') {
            onShowToast('🔒 Encrypted session connected', 'success');
          } else if (newStatus === 'disconnected') {
            messagesRef.current.forEach(revokeFileBlobUrl);
            setMessages([]);
            setAttachedFile(null);
            onShowToast(details?.message || 'Peer disconnected', 'warning');
          } else if (newStatus === 'error') {
            messagesRef.current.forEach(revokeFileBlobUrl);
            setMessages([]);
            setAttachedFile(null);
            onShowToast(details?.message || 'Connection error', 'error');
          }
        },
        onPeerIdentityLinked: (linkedPeer) => {
          onSetVerifiedPeer(linkedPeer);
          saveSessionPeer(linkedPeer);
        },
        onRoomCreated: (code) => {
          setRoomCode(code);
        },
        onRoomJoined: (code) => {
          setRoomCode(code);
        },
        onMessageReceived: (messageData) => {
          handleIncomingMessageOrFile(messageData);
        },
        onFileProgress: (fileProgressData) => {
          handleIncomingMessageOrFile(fileProgressData);
        },
      },
      myIdentity,
      peerToUse,
      customServerUrl
    );

    sessionRef.current = session;
    return session;
  };

  const handleStartChat = async () => {
    messagesRef.current.forEach(revokeFileBlobUrl);
    setMessages([]);
    setRoomCode('');
    const session = initSession(verifiedPeer);
    if (session) {
      await session.createRoom();
    }
  };

  const handleDirectJoinRoom = async (codeToJoin, peerToUse = verifiedPeer) => {
    const cleanCode = (codeToJoin || joinInput).trim().toUpperCase();
    if (!cleanCode || cleanCode.length < 6) {
      onShowToast('Please enter a valid 6-character room code', 'warning');
      return;
    }
    messagesRef.current.forEach(revokeFileBlobUrl);
    setMessages([]);
    setRoomCode(cleanCode);
    const session = initSession(peerToUse);
    if (session) {
      await session.joinRoom(cleanCode);
    }
  };

  const handleSendMessage = async (e) => {
    e?.preventDefault();
    if (!inputText.trim() || !sessionRef.current || status !== 'connected') return;

    const textToSend = inputText.trim();
    setInputText('');

    try {
      const sentMsg = await sessionRef.current.sendMessage(textToSend, {
        ttlSeconds: DEFAULT_TTL_SECONDS,
        burnOnRead: burnOnReadEnabled,
      });
      setMessages((prev) => [...prev, sentMsg]);
    } catch (err) {
      console.error('[WebRTC] Send message failed:', err);
      onShowToast(`Failed to send message: ${err.message}`, 'error');
    }
  };

  const handleSelectFile = (file) => {
    if (!file) return;
    if (file.size > MAX_FILE_SIZE) {
      onShowToast(`File exceeds 25MB limit (${formatFileSize(file.size)})`, 'error');
      return;
    }
    setAttachedFile(file);
  };

  const handleFileInputChange = (e) => {
    const file = e.target.files?.[0];
    if (file) handleSelectFile(file);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleSendAttachedFile = async () => {
    if (!attachedFile || !sessionRef.current || status !== 'connected' || isSendingFile) return;

    setIsSendingFile(true);
    try {
      const fileRecord = await sessionRef.current.sendFile(
        attachedFile,
        {
          ttlSeconds: fileTtlSeconds,
          burnOnRead: fileBurnOnRead,
        },
        (progressData) => {
          handleIncomingMessageOrFile(progressData);
        }
      );

      handleIncomingMessageOrFile(fileRecord);
      setAttachedFile(null);
      setFileBurnOnRead(false);
      setFileTtlSeconds(DEFAULT_FILE_TTL_SECONDS);
      onShowToast('File sent', 'success');
    } catch (err) {
      console.error('[WebRTC] File send failed:', err);
      onShowToast(`File send failed: ${err.message}`, 'error');
    } finally {
      setIsSendingFile(false);
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (status === 'connected') setIsDraggingOver(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget.contains(e.relatedTarget)) return;
    setIsDraggingOver(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);

    if (status !== 'connected') return;
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      handleSelectFile(files[0]);
    }
  };

  const handleDisconnect = () => {
    if (sessionRef.current) {
      sessionRef.current.cleanup(true);
    }
    setStatus('idle');
    setStatusDetails(null);
    setRoomCode('');
    messagesRef.current.forEach(revokeFileBlobUrl);
    setMessages([]);
    setAttachedFile(null);
    onShowToast('Disconnected — memory wiped', 'info');
  };

  const handleCopyRoomCode = async () => {
    if (!roomCode) return;
    try {
      await navigator.clipboard.writeText(roomCode);
      setCopiedCode(true);
      onShowToast(`Room code ${roomCode} copied`, 'success');
      setTimeout(() => setCopiedCode(false), 2000);
    } catch {
      onShowToast('Failed to copy', 'error');
    }
  };

  const hostQrPayload = myIdentity?.publicJWKs && roomCode
    ? JSON.stringify({
        protocol: 'covert-chatter',
        version: 1,
        room: roomCode,
        fingerprint: myIdentity.fingerprint,
        ecdsa: myIdentity.publicJWKs.ecdsa,
        ecdh: myIdentity.publicJWKs.ecdh,
      })
    : '';

  return (
    <div className="space-y-6 animate-fade-in">
      <div id="covert-file-temp-scanner" style={{ display: 'none' }} />

      {/* Top Subtle Config Bar */}
      <div className="flex items-center justify-between text-xs text-slate-400 px-1">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-[#D4FF27] shadow-[0_0_8px_rgba(212,255,39,0.6)]" />
          <span className="font-semibold text-white">Peer-to-Peer Tunnel</span>
        </div>

        <button
          onClick={() => setShowServerConfig(!showServerConfig)}
          className="text-[11px] text-[#A8CC19] hover:text-[#D4FF27] flex items-center gap-1 transition-colors py-1 px-2 rounded-lg hover:bg-[#1C1C1C]"
        >
          <Server className="w-3 h-3" />
          <span>Server config</span>
          {showServerConfig ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>
      </div>

      {showServerConfig && (
        <div className="p-4 bg-[#1C1C1C] border border-[#A8CC19]/40 rounded-2xl space-y-3 text-xs shadow-xl animate-slide-up">
          <div className="flex items-center justify-between">
            <span className="font-bold text-white">Signaling Server URL</span>
            <span className="text-[11px] text-slate-400 font-mono">Default: {getDefaultSignalingUrl()}</span>
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={customServerUrl}
              onChange={(e) => setCustomServerUrl(e.target.value)}
              disabled={status !== 'idle' && status !== 'disconnected' && status !== 'error'}
              placeholder={getDefaultSignalingUrl()}
              className="flex-1 bg-[#121212] border border-[#A8CC19]/50 focus:border-[#D4FF27] rounded-xl px-3 py-2 text-xs text-white placeholder:text-slate-500 font-mono"
            />
            <button
              onClick={() => setCustomServerUrl(getDefaultSignalingUrl())}
              className="btn-secondary text-xs px-3 py-2"
            >
              Reset
            </button>
          </div>
        </div>
      )}

      {/* ======================================================================== */}
      {/* 1. LOBBY STATE (Dark Neon Charcoal Cards)                                */}
      {/* ========================================================================= */}
      {status === 'idle' || status === 'disconnected' || status === 'error' ? (
        <div className="space-y-5">
          {/* Reconnect Banner if peer is remembered in session */}
          {savedPeer && (
            <div className="glass-panel p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border-[#A8CC19]/50 bg-[#1C1C1C] shadow-lg">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-[#121212] border border-[#D4FF27] text-[#D4FF27] shadow-[0_0_10px_rgba(212,255,39,0.25)]">
                  <UserCheck className="w-4 h-4" />
                </div>
                <div>
                  <p className="text-xs font-bold text-white">Paired Peer</p>
                  <p className="text-xs text-[#A8CC19] font-mono">
                    {savedPeer.fingerprint.slice(0, 16)}...
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 w-full sm:w-auto">
                <button
                  onClick={handleStartChat}
                  className="btn-primary text-xs py-2 px-3.5 flex-1 sm:flex-initial flex items-center justify-center gap-1.5"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Start Chat</span>
                </button>
                <button
                  onClick={clearSessionPeer}
                  className="btn-secondary text-xs py-2 px-2.5 text-slate-400 hover:text-white"
                  title="Forget peer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}

          {/* Clean 2-Card Pairing Action Hub */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Start Chat Card */}
            <div className="glass-panel p-6 sm:p-8 flex flex-col justify-between space-y-6 hover:border-[#D4FF27]/60 hover:shadow-[0_0_20px_rgba(212,255,39,0.15)] transition-all bg-[#1C1C1C]">
              <div className="space-y-3">
                <div className="w-12 h-12 rounded-2xl bg-[#121212] border border-[#D4FF27] flex items-center justify-center text-[#D4FF27] shadow-[0_0_12px_rgba(212,255,39,0.25)]">
                  <QrCode className="w-6 h-6" />
                </div>
                <h3 className="text-lg font-bold text-white">Start Chat</h3>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Create a secure room and show your QR code to your friend to connect.
                </p>
              </div>

              <button
                onClick={handleStartChat}
                className="btn-primary w-full py-3 text-sm font-bold flex items-center justify-center gap-2"
              >
                <QrCode className="w-4 h-4" />
                <span>Start Chat & Show QR</span>
              </button>
            </div>

            {/* Join Chat Card */}
            <div className="glass-panel p-6 sm:p-8 flex flex-col justify-between space-y-6 hover:border-[#D4FF27]/60 hover:shadow-[0_0_20px_rgba(212,255,39,0.15)] transition-all bg-[#1C1C1C]">
              <div className="space-y-3">
                <div className="w-12 h-12 rounded-2xl bg-[#121212] border border-[#A8CC19] flex items-center justify-center text-[#A8CC19]">
                  <Camera className="w-6 h-6" />
                </div>
                <h3 className="text-lg font-bold text-white">Join Chat</h3>
                <p className="text-xs text-slate-300 leading-relaxed">
                  Open your camera to scan your friend's QR code and automatically connect.
                </p>
              </div>

              <button
                onClick={() => startCameraScanner()}
                className="btn-secondary w-full py-3 text-sm font-bold flex items-center justify-center gap-2"
              >
                <Camera className="w-4 h-4 text-[#A8CC19]" />
                <span>Join Chat (Scan QR)</span>
              </button>
            </div>
          </div>

          {/* Secondary Outlined Fallback Button */}
          <div className="flex flex-col items-center justify-center pt-2 sm:pt-4">
            <button
              type="button"
              onClick={() => setShowManualPeerInput(!showManualPeerInput)}
              className="inline-flex items-center justify-center gap-2 min-h-[44px] px-5 py-2.5 rounded-xl border border-[#A8CC19]/40 hover:border-[#D4FF27] bg-[#1C1C1C] hover:bg-[#242424] text-slate-300 hover:text-white text-xs sm:text-sm font-medium shadow-md transition-all active:scale-[0.98] touch-manipulation focus:outline-none focus-visible:ring-1 focus-visible:ring-[#D4FF27]"
              aria-expanded={showManualPeerInput}
            >
              <FileCode className="w-4 h-4 text-[#A8CC19]" />
              <span>Enter room code or paste JSON manually</span>
              {showManualPeerInput ? (
                <ChevronUp className="w-4 h-4 text-[#A8CC19] ml-0.5" />
              ) : (
                <ChevronDown className="w-4 h-4 text-[#A8CC19] ml-0.5" />
              )}
            </button>
          </div>

          {showManualPeerInput && (
            <div className="glass-panel p-5 space-y-4 max-w-md mx-auto animate-slide-up bg-[#1C1C1C] border-[#A8CC19]/50">
              <div className="flex items-center justify-between border-b border-[#2A2A2A] pb-2">
                <span className="text-xs font-bold text-white">Manual Room Connect</span>
                <button
                  onClick={() => setShowManualPeerInput(false)}
                  className="text-slate-400 hover:text-white"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-2">
                <label className="text-[11px] font-medium text-slate-400 block">
                  6-Character Room Code:
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    maxLength={6}
                    value={joinInput}
                    onChange={(e) => setJoinInput(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                    placeholder="E.G. ABC123"
                    className="flex-1 bg-[#121212] border border-[#A8CC19]/50 focus:border-[#D4FF27] rounded-xl px-3 py-2 font-mono text-center text-sm font-bold tracking-widest text-[#D4FF27] uppercase"
                  />
                  <button
                    onClick={() => handleDirectJoinRoom(joinInput)}
                    disabled={joinInput.length < 6}
                    className="btn-primary text-xs px-4 disabled:opacity-40"
                  >
                    Join
                  </button>
                </div>
              </div>

              <form onSubmit={handleManualPeerValidate} className="space-y-2 pt-2 border-t border-[#2A2A2A]">
                <label className="text-[11px] font-medium text-slate-400 block">
                  Or Paste Raw Peer Identity JSON:
                </label>
                <textarea
                  rows={2}
                  value={rawPeerJsonInput}
                  onChange={(e) => setRawPeerJsonInput(e.target.value)}
                  placeholder='{"protocol":"covert-chatter",...}'
                  className="w-full bg-[#121212] border border-[#A8CC19]/50 focus:border-[#D4FF27] rounded-xl p-2.5 text-xs font-mono text-white placeholder:text-slate-600"
                />
                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={!rawPeerJsonInput.trim()}
                    className="btn-secondary text-xs py-1.5 px-3 disabled:opacity-40"
                  >
                    Validate & Link
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>
      ) : null}

      {/* ========================================================================= */}
      {/* 2. CAMERA SCANNER (Dark Neon Viewfinder)                                  */}
      {/* ========================================================================= */}
      {isJoinScannerOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 animate-fade-in">
          <div className="bg-[#1C1C1C] rounded-2xl max-w-sm w-full p-5 space-y-4 shadow-2xl border border-[#A8CC19]/60 animate-scale-up">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Camera className="w-4 h-4 text-[#D4FF27]" />
                <h3 className="text-sm font-bold text-white">Scan QR Code</h3>
              </div>
              <button
                onClick={stopCameraScanner}
                className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-[#242424]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Viewfinder Frame */}
            <div className="relative rounded-xl overflow-hidden bg-black min-h-[260px] flex items-center justify-center border border-[#A8CC19]/40">
              <div id={scannerContainerId} className="w-full max-w-xs overflow-hidden rounded-lg" />
              <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                <div className="w-48 h-48 border-2 border-[#D4FF27] rounded-2xl shadow-[0_0_15px_rgba(212,255,39,0.4)]" />
              </div>
            </div>

            {cameraError && (
              <p className="text-xs text-rose-400 bg-rose-500/10 p-2.5 rounded-xl border border-rose-500/30">
                {cameraError}
              </p>
            )}

            <div className="flex items-center justify-between gap-2 pt-1 border-t border-[#2A2A2A]">
              <input
                type="file"
                ref={qrFileInputRef}
                onChange={handleQrFileUpload}
                accept="image/*"
                className="hidden"
              />
              <button
                onClick={() => qrFileInputRef.current?.click()}
                disabled={isProcessingFile}
                className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5 flex-1 justify-center"
              >
                <FileImage className="w-3.5 h-3.5 text-[#A8CC19]" />
                <span>{isProcessingFile ? 'Reading...' : 'Upload Image'}</span>
              </button>
              <button
                onClick={stopCameraScanner}
                className="btn-secondary text-xs py-2 px-3"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 3. HOST WAITING STATE (Show QR to Friend)                                */}
      {/* ========================================================================= */}
      {status === 'waiting' && roomCode && (
        <div className="glass-panel p-6 sm:p-8 text-center max-w-md mx-auto space-y-5 animate-scale-up bg-[#1C1C1C] border-[#A8CC19]/50">
          <div className="space-y-1">
            <span className="badge-neon text-xs">Room Ready</span>
            <h3 className="text-lg font-bold text-white">Show this to your friend</h3>
            <p className="text-xs text-slate-300">
              Scan this code with "Join Chat" to begin
            </p>
          </div>

          <div className="p-4 bg-white rounded-2xl border-2 border-[#D4FF27] inline-block shadow-[0_0_20px_rgba(212,255,39,0.2)]">
            <QRCodeSVG
              value={hostQrPayload}
              size={200}
              level="M"
              includeMargin={false}
              bgColor="#FFFFFF"
              fgColor="#121212"
            />
          </div>

          <div className="space-y-1">
            <span className="text-[11px] text-slate-400 uppercase tracking-wider font-semibold">
              Room Code
            </span>
            <div className="flex items-center justify-center gap-2">
              <span className="font-mono text-2xl font-bold tracking-widest text-[#D4FF27] bg-[#121212] px-5 py-2 rounded-xl border border-[#A8CC19]/50 select-all shadow-[0_0_12px_rgba(212,255,39,0.2)]">
                {roomCode}
              </span>
              <button
                onClick={handleCopyRoomCode}
                className="p-2.5 rounded-xl bg-[#121212] border border-[#A8CC19]/50 hover:border-[#D4FF27] text-white hover:text-[#D4FF27] transition-all"
                title="Copy Code"
              >
                {copiedCode ? <Check className="w-4 h-4 text-[#D4FF27]" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div className="flex items-center justify-center gap-2 text-xs text-slate-300 pt-1">
            <Loader2 className="w-4 h-4 animate-spin text-[#D4FF27]" />
            <span>Waiting for friend to connect...</span>
          </div>

          <div className="pt-2">
            <button
              onClick={handleDisconnect}
              className="btn-secondary text-xs py-2 px-4"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 4. CONNECTING STATE                                                      */}
      {/* ========================================================================= */}
      {(status === 'creating' || status === 'joining' || status === 'connecting') && status !== 'waiting' && (
        <div className="glass-panel p-8 text-center max-w-sm mx-auto space-y-4 animate-scale-up bg-[#1C1C1C] border-[#A8CC19]/50">
          <div className="w-12 h-12 rounded-2xl bg-[#121212] border border-[#D4FF27] flex items-center justify-center text-[#D4FF27] mx-auto shadow-[0_0_15px_rgba(212,255,39,0.3)]">
            <RefreshCw className="w-6 h-6 animate-spin" />
          </div>

          <div className="space-y-1">
            <h3 className="text-base font-bold text-white">
              {verifiedPeer ? `Connecting to ${verifiedPeer.fingerprint.slice(0, 8)}...` : 'Connecting...'}
            </h3>
            <p className="text-xs text-slate-300">
              Establishing end-to-end encrypted session
            </p>
          </div>

          <div className="pt-2">
            <button
              onClick={handleDisconnect}
              className="btn-secondary text-xs py-1.5 px-3"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 5. CONNECTED CHAT SCREEN (Reference-Matched Comic Bubble Chat System)     */}
      {/* ========================================================================= */}
      {status === 'connected' && (() => {
        const lastSentMessage = [...messages].reverse().find((m) => m.sender === 'me');
        const lastSentMessageId = lastSentMessage ? lastSentMessage.id : null;
        const peerInitials = verifiedPeer?.fingerprint ? verifiedPeer.fingerprint.slice(0, 2).toUpperCase() : 'PE';
        const peerDisplayName = verifiedPeer?.fingerprint ? `Peer ${verifiedPeer.fingerprint.slice(0, 8)}` : 'Connected Peer';

        return (
          <div 
            onDragOver={handleDragOver}
            onDragEnter={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`rounded-[28px] border-2 border-black overflow-hidden flex flex-col h-[660px] relative transition-all chat-yellow-wallpaper shadow-2xl ${
              isDraggingOver ? 'ring-4 ring-emerald-500/50' : ''
            }`}
          >
            {/* Hidden File Input */}
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileInputChange}
              className="hidden"
            />

            {/* Drag Overlay */}
            {isDraggingOver && (
              <div className="absolute inset-0 z-50 bg-[#FBF658]/95 border-2 border-dashed border-black rounded-[26px] flex flex-col items-center justify-center p-6 space-y-2 pointer-events-none animate-fade-in">
                <UploadCloud className="w-12 h-12 text-black animate-bounce" />
                <h3 className="text-base font-extrabold text-black">Drop file to send</h3>
                <p className="text-xs text-black/80 font-medium">Encrypted in 16KB blocks (Up to 25MB)</p>
              </div>
            )}

            {/* HEADER (Exact Reference: Left Circle '<', Peer Avatar + Name, Right Circle '⋮') */}
            <div className="px-4 sm:px-6 py-3.5 flex items-center justify-between gap-3 shrink-0 relative z-20">
              <div className="flex items-center gap-3 min-w-0">
                {/* Left Circular Back Button '<' */}
                <button
                  type="button"
                  onClick={handleDisconnect}
                  className="chat-circle-btn"
                  title="Leave Room & Disconnect"
                  aria-label="Back"
                >
                  <ChevronLeft className="w-5 h-5 stroke-[2.5]" />
                </button>

                {/* Peer avatar circle with 2px black border */}
                <div className="relative shrink-0">
                  <div 
                    className="w-10 h-10 min-w-[40px] min-h-[40px] rounded-full border-2 border-black bg-[#CEF97A] text-black font-extrabold text-sm flex items-center justify-center font-mono select-none shadow-xs"
                    title={verifiedPeer?.fingerprint || 'Peer'}
                  >
                    {peerInitials}
                  </div>
                  {/* Connected Status Dot */}
                  <span 
                    className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-[#22C55E] rounded-full border border-black"
                    title="Connected"
                  />
                </div>

                {/* Peer Name & Room Details */}
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="text-base sm:text-lg font-black text-black tracking-tight truncate">
                      {peerDisplayName}
                    </h2>

                    {/* Encrypted Pill Badge */}
                    <button
                      onClick={() => setShowSecurityModal(true)}
                      className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-white text-black border-2 border-black shadow-xs hover:bg-black hover:text-white transition-all cursor-pointer"
                      title="Click for security & encryption details"
                    >
                      <Lock className="w-2.5 h-2.5" />
                      <span>Encrypted</span>
                    </button>
                  </div>
                  <p className="text-[11px] text-black/70 font-mono font-medium truncate">
                    Room: {roomCode} {connectionType ? `• ${connectionType === 'direct' ? '⚡ Direct' : '🖥️ Relay'}` : ''}
                  </p>
                </div>
              </div>

              {/* Right: Circular '⋮' / '⋯' 3-Dots Button */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowOptionsMenu(!showOptionsMenu)}
                  className="chat-circle-btn"
                  title="Session Options"
                  aria-label="Options"
                >
                  <MoreVertical className="w-5 h-5 stroke-[2.5]" />
                </button>

                {/* Options Dropdown Menu */}
                {showOptionsMenu && (
                  <>
                    <div 
                      className="fixed inset-0 z-30" 
                      onClick={() => setShowOptionsMenu(false)} 
                    />
                    <div className="absolute right-0 top-12 z-40 w-56 bg-white rounded-2xl border-2 border-black p-2 shadow-2xl space-y-1 animate-scale-up">
                      <div className="px-3 py-2 border-b border-black/10">
                        <p className="text-xs font-black text-black">Session Options</p>
                        <p className="text-[10px] text-slate-500 font-mono truncate">Room: {roomCode}</p>
                      </div>

                      <button
                        type="button"
                        onClick={() => {
                          handleCopyRoomCode();
                          setShowOptionsMenu(false);
                        }}
                        className="w-full text-left px-3 py-2 rounded-xl text-xs text-black hover:bg-slate-100 flex items-center gap-2 transition-colors font-semibold cursor-pointer"
                      >
                        <Copy className="w-3.5 h-3.5" />
                        <span>Copy Room Code</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setShowSecurityModal(true);
                          setShowOptionsMenu(false);
                        }}
                        className="w-full text-left px-3 py-2 rounded-xl text-xs text-black hover:bg-slate-100 flex items-center gap-2 transition-colors font-semibold cursor-pointer"
                      >
                        <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                        <span>Security & Encryption</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setShowOptionsMenu(false);
                          handleDisconnect();
                        }}
                        className="w-full text-left px-3 py-2 rounded-xl text-xs text-rose-600 hover:bg-rose-50 flex items-center gap-2 transition-colors font-bold cursor-pointer border-t border-black/10 mt-1"
                      >
                        <Trash2 className="w-3.5 h-3.5 text-rose-600" />
                        <span>Leave Room & Wipe</span>
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Security Details Modal (When triggered from Options) */}
            {showSecurityModal && (
              <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in">
                <div className="bg-white rounded-2xl max-w-sm w-full p-5 space-y-4 shadow-2xl border-2 border-black animate-scale-up">
                  <div className="flex items-center justify-between border-b border-black/10 pb-2">
                    <div className="flex items-center gap-2 text-black">
                      <ShieldCheck className="w-5 h-5 text-emerald-600" />
                      <h3 className="text-base font-black text-black">Session Security</h3>
                    </div>
                    <button
                      onClick={() => setShowSecurityModal(false)}
                      className="p-1 text-slate-400 hover:text-black rounded-lg"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="space-y-2.5 text-xs text-black">
                    <div className="p-3 bg-[#FAF9F6] border-2 border-black rounded-xl space-y-0.5">
                      <p className="font-extrabold text-black">Symmetric Encryption</p>
                      <p className="font-mono text-[11px] text-slate-700">AES-256-GCM (Fresh 12-byte IV per message)</p>
                    </div>
                    <div className="p-3 bg-[#FAF9F6] border-2 border-black rounded-xl space-y-0.5">
                      <p className="font-extrabold text-black">Digital Signatures</p>
                      <p className="font-mono text-[11px] text-slate-700">ECDSA P-256 (SHA-256 Digest)</p>
                    </div>
                    <div className="p-3 bg-[#FAF9F6] border-2 border-black rounded-xl space-y-0.5">
                      <p className="font-extrabold text-black">Key Agreement</p>
                      <p className="font-mono text-[11px] text-slate-700">ECDH P-256 (Diffie-Hellman Shared Secret)</p>
                    </div>
                    <div className="p-3 bg-[#FAF9F6] border-2 border-black rounded-xl space-y-0.5">
                      <p className="font-extrabold text-black">Ephemeral Storage</p>
                      <p className="text-[11px] text-slate-600">Volatile RAM only. Wiped on leave, tab close, or 30s background blur.</p>
                    </div>
                  </div>

                  <button
                    onClick={() => setShowSecurityModal(false)}
                    className="w-full py-2 text-xs font-bold bg-black text-white rounded-xl border-2 border-black cursor-pointer hover:bg-slate-800"
                  >
                    Close
                  </button>
                </div>
              </div>
            )}

            {/* CHAT BUBBLES STREAM (Reference-Matched: Lime peer bubbles, Crisp White sent bubbles with left green checkmark) */}
            <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
              {messages.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center p-6 text-black space-y-3">
                  <div className="w-12 h-12 rounded-full bg-white border-2 border-black flex items-center justify-center text-black shadow-xs">
                    <Sparkles className="w-6 h-6 text-emerald-600" />
                  </div>
                  <p className="text-base font-extrabold text-black">Encrypted tunnel established</p>
                  <p className="text-xs text-black/80 max-w-xs font-medium leading-relaxed">
                    Messages are end-to-end encrypted with AES-256-GCM and ephemeral in volatile RAM.
                  </p>
                </div>
              ) : (
                messages.map((msg) => {
                  const isMe = msg.sender === 'me';
                  const remainingSecs = getRemainingSeconds(msg, currentTime);
                  const isBurn = msg.burnOnRead;
                  const isFile = msg.type === 'file';
                  const isMostRecentSent = isMe && msg.id === lastSentMessageId;
                  const timeStr = msg.timestamp
                    ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    : '';

                  if (isMe) {
                    // SENT (MY) MESSAGE: White bubble, Docked left tick + timestamp (e.g. ✓ 11:40)
                    return (
                      <div
                        key={msg.id}
                        className={`flex justify-end items-end gap-2 animate-bubble-pop ${
                          remainingSecs <= 2 ? 'opacity-40 transition-opacity' : 'opacity-100'
                        }`}
                      >
                        {/* Outside Left: Green Checkmark + Timestamp + Burn info */}
                        <div className="flex flex-col items-end gap-0.5 select-none pb-1 shrink-0">
                          {isBurn && (
                            <span className="inline-flex items-center gap-0.5 font-bold text-[10px] text-amber-900 bg-amber-200/90 border border-amber-500 px-1.5 py-0.2 rounded-full mb-0.5 shadow-xs">
                              <Flame className="w-2.5 h-2.5 text-amber-900" />
                              <span>{remainingSecs}s</span>
                            </span>
                          )}
                          <div className="flex items-center gap-1 text-[11px] font-bold text-black/80 font-mono">
                            <Check className="w-3.5 h-3.5 text-[#16A34A] stroke-[3] animate-check-pop" />
                            <span>{timeStr}</span>
                          </div>
                        </div>

                        {/* White Sent Bubble */}
                        <div className="relative max-w-[78%] sm:max-w-[72%]">
                          <div className="bubble-comic-mine">
                            {isFile ? (
                              <div className="space-y-2 min-w-[200px] sm:min-w-[230px]">
                                <div className="flex items-start gap-2.5">
                                  <div className="p-2 rounded-xl bg-black/5 border border-black text-black shrink-0">
                                    {msg.status === 'completed' ? (
                                      <FileText className="w-4.5 h-4.5" />
                                    ) : (
                                      <Loader2 className="w-4.5 h-4.5 animate-spin" />
                                    )}
                                  </div>

                                  <div className="flex-1 min-w-0">
                                    <p className="text-xs sm:text-sm font-bold text-black truncate" title={msg.fileName}>
                                      {msg.fileName}
                                    </p>
                                    <span className="text-[10px] text-black/70 font-mono font-semibold">
                                      {formatFileSize(msg.fileSize)}
                                    </span>
                                  </div>
                                </div>

                                {msg.status === 'transferring' ? (
                                  <div className="space-y-1 pt-1">
                                    <div className="w-full h-2 rounded-full overflow-hidden bg-black/15 border border-black/30">
                                      <div
                                        className="h-full transition-all duration-150 bg-black"
                                        style={{ width: `${msg.progress || 0}%` }}
                                      />
                                    </div>
                                  </div>
                                ) : msg.status === 'completed' && msg.blobUrl ? (
                                  <div className="pt-1">
                                    <a
                                      href={msg.blobUrl}
                                      download={msg.fileName}
                                      className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-bold bg-[#CEF97A] border-2 border-black text-black hover:bg-[#B9F06A] transition-all shadow-xs"
                                    >
                                      <Download className="w-3 h-3" />
                                      <span>Download</span>
                                    </a>
                                  </div>
                                ) : null}
                              </div>
                            ) : (
                              <p className="text-[15px] sm:text-[16px] leading-relaxed font-medium whitespace-pre-wrap text-black">
                                {msg.text}
                              </p>
                            )}
                          </div>

                          {/* Heart Read Receipt Badge on most recent sent bubble */}
                          {isMostRecentSent && (
                            <div 
                              className="absolute -bottom-2 -right-1.5 bg-white border-2 border-black rounded-full w-5 h-5 flex items-center justify-center shadow-xs animate-heart-pop"
                              title="Delivered"
                            >
                              <Heart className="w-2.5 h-2.5 text-rose-500 fill-rose-500" />
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  } else {
                    // INCOMING (PEER) MESSAGE: Avatar on left, name above, lime bubble, timestamp on right
                    return (
                      <div
                        key={msg.id}
                        className={`flex items-start gap-2.5 animate-bubble-pop ${
                          remainingSecs <= 2 ? 'opacity-40 transition-opacity' : 'opacity-100'
                        }`}
                      >
                        {/* Peer Avatar */}
                        <div 
                          className="w-9 h-9 min-w-[36px] min-h-[36px] rounded-full border-2 border-black bg-[#CEF97A] text-black font-extrabold text-xs flex items-center justify-center font-mono select-none shadow-xs shrink-0 mt-4"
                          title={verifiedPeer?.fingerprint || 'Peer'}
                        >
                          {peerInitials}
                        </div>

                        {/* Peer Message Stack */}
                        <div className="flex flex-col items-start max-w-[78%] sm:max-w-[72%]">
                          {/* Peer Name Tag */}
                          <span className="text-xs font-bold text-black ml-1 mb-0.5 select-none">
                            {peerDisplayName}
                          </span>

                          <div className="flex items-end gap-2">
                            {/* Lime Peer Bubble */}
                            <div className="bubble-comic-peer">
                              {isFile ? (
                                <div className="space-y-2 min-w-[200px] sm:min-w-[230px]">
                                  <div className="flex items-start gap-2.5">
                                    <div className="p-2 rounded-xl bg-white border border-black text-black shrink-0">
                                      {msg.status === 'completed' ? (
                                        <FileText className="w-4.5 h-4.5" />
                                      ) : (
                                        <Loader2 className="w-4.5 h-4.5 animate-spin" />
                                      )}
                                    </div>

                                    <div className="flex-1 min-w-0">
                                      <p className="text-xs sm:text-sm font-bold text-black truncate" title={msg.fileName}>
                                        {msg.fileName}
                                      </p>
                                      <span className="text-[10px] text-black/70 font-mono font-semibold">
                                        {formatFileSize(msg.fileSize)}
                                      </span>
                                    </div>
                                  </div>

                                  {msg.status === 'transferring' ? (
                                    <div className="space-y-1 pt-1">
                                      <div className="w-full h-2 rounded-full overflow-hidden bg-black/15 border border-black/30">
                                        <div
                                          className="h-full transition-all duration-150 bg-black"
                                          style={{ width: `${msg.progress || 0}%` }}
                                        />
                                      </div>
                                    </div>
                                  ) : msg.status === 'completed' && msg.blobUrl ? (
                                    <div className="pt-1">
                                      <a
                                        href={msg.blobUrl}
                                        download={msg.fileName}
                                        className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-bold bg-white border-2 border-black text-black hover:bg-slate-100 transition-all shadow-xs"
                                      >
                                        <Download className="w-3 h-3" />
                                        <span>Download</span>
                                      </a>
                                    </div>
                                  ) : null}
                                </div>
                              ) : (
                                <p className="text-[15px] sm:text-[16px] leading-relaxed font-medium whitespace-pre-wrap text-black">
                                  {msg.text}
                                </p>
                              )}
                            </div>

                            {/* Outside Right: Timestamp + Translation icon + Burn countdown */}
                            <div className="flex flex-col items-start gap-0.5 select-none pb-1 shrink-0">
                              {isBurn && (
                                <span className="inline-flex items-center gap-0.5 font-bold text-[10px] text-amber-900 bg-amber-200/90 border border-amber-500 px-1.5 py-0.2 rounded-full mb-0.5 shadow-xs">
                                  <Flame className="w-2.5 h-2.5 text-amber-900" />
                                  <span>{remainingSecs}s</span>
                                </span>
                              )}
                              <div className="flex items-center gap-1 text-[11px] font-bold text-black/75 font-mono">
                                <span>{timeStr}</span>
                                <Languages className="w-3 h-3 text-black/60" />
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  }
                })
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Staged File Preview Bar */}
            {attachedFile && (
              <div className="px-4 py-2.5 bg-white border-t-2 border-black flex items-center justify-between gap-3 text-xs animate-slide-up">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-7 h-7 rounded-full border-2 border-black bg-[#CEF97A] flex items-center justify-center text-black shrink-0">
                    <File className="w-3.5 h-3.5" />
                  </div>
                  <span className="font-bold text-black truncate max-w-[180px] sm:max-w-xs">{attachedFile.name}</span>
                  <span className="text-black/70 shrink-0 font-mono font-semibold">({formatFileSize(attachedFile.size)})</span>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => setFileBurnOnRead(!fileBurnOnRead)}
                    className={`px-2.5 py-1 rounded-full text-[11px] font-bold flex items-center gap-1 border-2 border-black transition-colors cursor-pointer ${
                      fileBurnOnRead
                        ? 'bg-[#FFD479] text-black shadow-xs'
                        : 'bg-white text-black hover:bg-slate-100'
                    }`}
                    title="Burn file on read"
                  >
                    <Flame className="w-3 h-3" />
                    <span>Burn</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setAttachedFile(null)}
                    className="w-7 h-7 rounded-full border-2 border-black bg-white hover:bg-slate-100 text-black flex items-center justify-center cursor-pointer"
                    title="Cancel attachment"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>

                  <button
                    type="button"
                    onClick={handleSendAttachedFile}
                    disabled={isSendingFile}
                    className="px-3.5 py-1 rounded-full border-2 border-black bg-[#CEF97A] hover:bg-[#B9F06A] text-black font-extrabold text-xs flex items-center gap-1.5 cursor-pointer shadow-xs disabled:opacity-40"
                  >
                    {isSendingFile ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                    <span>Send</span>
                  </button>
                </div>
              </div>
            )}

            {/* FOOTER (Exact Reference: Yellow bar, White rounded pill input with 2px black border, photo/attach on left, flame burn-toggle, green paper-plane on right) */}
            <div className="p-3.5 sm:p-4 bg-[#F8F34E] border-t-2 border-black shrink-0">
              <form onSubmit={handleSendMessage} className="flex items-center">
                {/* White Pill Input Container with 2px Black Border */}
                <div className="w-full bg-white border-2 border-black rounded-full px-3.5 py-1.5 flex items-center gap-2.5 shadow-md">
                  {/* Photo/Camera Attach Icon */}
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="p-1 rounded-full hover:bg-slate-100 text-black transition-colors shrink-0 cursor-pointer"
                    title="Attach File or Photo (Encrypted P2P)"
                    aria-label="Attach file"
                  >
                    <Camera className="w-5 h-5 stroke-[2.2] text-black hover:text-emerald-700" />
                  </button>

                  {/* Text Input */}
                  <input
                    type="text"
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    placeholder="Enter a message."
                    className="flex-1 bg-transparent border-none outline-none text-[15px] sm:text-[16px] font-medium text-black placeholder:text-stone-400 py-1"
                  />

                  {/* Burn-on-Read Flame Toggle */}
                  <button
                    type="button"
                    onClick={() => setBurnOnReadEnabled(!burnOnReadEnabled)}
                    className={`p-1.5 rounded-full border transition-all shrink-0 cursor-pointer ${
                      burnOnReadEnabled
                        ? 'bg-amber-300 border-black text-black shadow-xs'
                        : 'border-transparent text-black/50 hover:text-black hover:bg-slate-100'
                    }`}
                    title={burnOnReadEnabled ? 'Burn on Read: Active (5s)' : 'Turn on Burn-on-Read'}
                    aria-label="Toggle burn on read"
                  >
                    <Flame className={`w-4 h-4 ${burnOnReadEnabled ? 'fill-black text-black' : ''}`} />
                  </button>

                  {/* Green Paper-Plane Send Button */}
                  <button
                    type="submit"
                    disabled={!inputText.trim()}
                    className="chat-comic-send-btn p-1 shrink-0"
                    title="Send message"
                    aria-label="Send message"
                  >
                    <Send className="w-6 h-6 text-[#16A34A] fill-[#DCFCE7] hover:fill-[#86EFAC] stroke-[2.2] transition-colors" />
                  </button>
                </div>
              </form>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
