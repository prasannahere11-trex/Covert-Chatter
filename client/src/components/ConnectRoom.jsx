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
  HelpCircle
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
      <div className="flex items-center justify-between text-xs text-slate-500 px-1">
        <div className="flex items-center gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full bg-sage-500" />
          <span>Peer-to-Peer Tunnel</span>
        </div>

        <button
          onClick={() => setShowServerConfig(!showServerConfig)}
          className="text-[11px] text-slate-400 hover:text-slate-600 flex items-center gap-1 transition-colors"
        >
          <Server className="w-3 h-3" />
          <span>Server config</span>
          {showServerConfig ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>
      </div>

      {showServerConfig && (
        <div className="p-3 bg-white border border-slate-200 rounded-xl space-y-2 text-xs shadow-sm">
          <div className="flex items-center justify-between">
            <span className="font-medium text-slate-700">Signaling Server URL</span>
            <span className="text-[11px] text-slate-400">Default: {getDefaultSignalingUrl()}</span>
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={customServerUrl}
              onChange={(e) => setCustomServerUrl(e.target.value)}
              disabled={status !== 'idle' && status !== 'disconnected' && status !== 'error'}
              placeholder={getDefaultSignalingUrl()}
              className="flex-1 bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-xs text-slate-800"
            />
            <button
              onClick={() => setCustomServerUrl(getDefaultSignalingUrl())}
              className="btn-secondary text-xs px-3 py-1.5"
            >
              Reset
            </button>
          </div>
        </div>
      )}

      {/* ======================================================================== */}
      {/* 1. LOBBY STATE (Clean Pale Light Theme)                                 */}
      {/* ========================================================================= */}
      {status === 'idle' || status === 'disconnected' || status === 'error' ? (
        <div className="space-y-5">
          {/* Reconnect Banner if peer is remembered in session */}
          {savedPeer && (
            <div className="glass-panel p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border-sage-200 bg-sage-50/50">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-white border border-sage-200 text-sage-600">
                  <UserCheck className="w-4 h-4" />
                </div>
                <div>
                  <p className="text-xs font-semibold text-slate-900">Paired Peer</p>
                  <p className="text-xs text-slate-500 font-mono">
                    {savedPeer.fingerprint.slice(0, 16)}...
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 w-full sm:w-auto">
                <button
                  onClick={handleStartChat}
                  className="btn-primary text-xs py-1.5 px-3 flex-1 sm:flex-initial flex items-center justify-center gap-1.5"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Start Chat</span>
                </button>
                <button
                  onClick={clearSessionPeer}
                  className="btn-secondary text-xs py-1.5 px-2 text-slate-400 hover:text-slate-600"
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
            <div className="glass-panel p-6 sm:p-8 flex flex-col justify-between space-y-6 hover:border-slate-300 transition-all">
              <div className="space-y-2">
                <div className="w-12 h-12 rounded-xl bg-sage-50 border border-sage-200 flex items-center justify-center text-sage-600">
                  <QrCode className="w-6 h-6" />
                </div>
                <h3 className="text-lg font-bold text-slate-900">Start Chat</h3>
                <p className="text-xs text-slate-500 leading-relaxed">
                  Create a secure room and show your QR code to your friend to connect.
                </p>
              </div>

              <button
                onClick={handleStartChat}
                className="btn-primary w-full py-3 text-sm font-semibold flex items-center justify-center gap-2"
              >
                <QrCode className="w-4 h-4" />
                <span>Start Chat & Show QR</span>
              </button>
            </div>

            {/* Join Chat Card */}
            <div className="glass-panel p-6 sm:p-8 flex flex-col justify-between space-y-6 hover:border-slate-300 transition-all">
              <div className="space-y-2">
                <div className="w-12 h-12 rounded-xl bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-700">
                  <Camera className="w-6 h-6" />
                </div>
                <h3 className="text-lg font-bold text-slate-900">Join Chat</h3>
                <p className="text-xs text-slate-500 leading-relaxed">
                  Open your camera to scan your friend's QR code and automatically connect.
                </p>
              </div>

              <button
                onClick={() => startCameraScanner()}
                className="btn-secondary w-full py-3 text-sm font-semibold flex items-center justify-center gap-2"
              >
                <Camera className="w-4 h-4 text-slate-600" />
                <span>Join Chat (Scan QR)</span>
              </button>
            </div>
          </div>

          {/* Secondary Outlined Fallback Button */}
          <div className="flex flex-col items-center justify-center pt-2 sm:pt-4">
            <button
              type="button"
              onClick={() => setShowManualPeerInput(!showManualPeerInput)}
              className="inline-flex items-center justify-center gap-2 min-h-[44px] px-5 py-2.5 rounded-xl border border-slate-300 hover:border-slate-400 bg-white hover:bg-slate-50 text-slate-700 hover:text-slate-900 text-xs sm:text-sm font-medium shadow-xs transition-all active:scale-[0.98] touch-manipulation focus:outline-none focus-visible:ring-2 focus-visible:ring-sage-400"
              aria-expanded={showManualPeerInput}
            >
              <FileCode className="w-4 h-4 text-slate-500" />
              <span>Enter room code or paste JSON manually</span>
              {showManualPeerInput ? (
                <ChevronUp className="w-4 h-4 text-slate-400 ml-0.5" />
              ) : (
                <ChevronDown className="w-4 h-4 text-slate-400 ml-0.5" />
              )}
            </button>
          </div>

          {showManualPeerInput && (
            <div className="glass-panel p-5 space-y-4 max-w-md mx-auto animate-slide-up">
              <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                <span className="text-xs font-semibold text-slate-700">Manual Room Connect</span>
                <button
                  onClick={() => setShowManualPeerInput(false)}
                  className="text-slate-400 hover:text-slate-600"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-2">
                <label className="text-[11px] font-medium text-slate-500 block">
                  6-Character Room Code:
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    maxLength={6}
                    value={joinInput}
                    onChange={(e) => setJoinInput(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                    placeholder="E.G. ABC123"
                    className="flex-1 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 font-mono text-center text-sm font-bold tracking-widest text-slate-800 uppercase"
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

              <form onSubmit={handleManualPeerValidate} className="space-y-2 pt-2 border-t border-slate-100">
                <label className="text-[11px] font-medium text-slate-500 block">
                  Or Paste Raw Peer Identity JSON:
                </label>
                <textarea
                  rows={2}
                  value={rawPeerJsonInput}
                  onChange={(e) => setRawPeerJsonInput(e.target.value)}
                  placeholder='{"protocol":"covert-chatter",...}'
                  className="w-full bg-slate-50 border border-slate-200 rounded-lg p-2 text-xs font-mono text-slate-800"
                />
                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={!rawPeerJsonInput.trim()}
                    className="btn-secondary text-xs py-1 px-3 disabled:opacity-40"
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
      {/* 2. CAMERA SCANNER (Clean Minimal Viewfinder)                             */}
      {/* ========================================================================= */}
      {isJoinScannerOpen && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4 animate-fade-in">
          <div className="bg-white rounded-2xl max-w-sm w-full p-5 space-y-4 shadow-xl border border-slate-200 animate-scale-up">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Camera className="w-4 h-4 text-slate-700" />
                <h3 className="text-sm font-bold text-slate-900">Scan QR Code</h3>
              </div>
              <button
                onClick={stopCameraScanner}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Clean Viewfinder Frame */}
            <div className="relative rounded-xl overflow-hidden bg-slate-950 min-h-[260px] flex items-center justify-center">
              <div id={scannerContainerId} className="w-full max-w-xs overflow-hidden rounded-lg" />
              <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                <div className="w-48 h-48 border border-white/60 rounded-xl" />
              </div>
            </div>

            {cameraError && (
              <p className="text-xs text-rose-600 bg-rose-50 p-2.5 rounded-lg border border-rose-200">
                {cameraError}
              </p>
            )}

            <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-100">
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
                <FileImage className="w-3.5 h-3.5 text-slate-500" />
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
        <div className="glass-panel p-6 sm:p-8 text-center max-w-md mx-auto space-y-5 animate-scale-up">
          <div className="space-y-1">
            <span className="badge-sage text-xs">Room Ready</span>
            <h3 className="text-lg font-bold text-slate-900">Show this to your friend</h3>
            <p className="text-xs text-slate-500">
              Scan this code with "Join Chat" to begin
            </p>
          </div>

          <div className="p-4 bg-white rounded-xl border border-slate-200 inline-block shadow-sm">
            <QRCodeSVG
              value={hostQrPayload}
              size={200}
              level="M"
              includeMargin={false}
            />
          </div>

          <div className="space-y-1">
            <span className="text-[11px] text-slate-400 uppercase tracking-wider font-medium">
              Room Code
            </span>
            <div className="flex items-center justify-center gap-2">
              <span className="font-mono text-2xl font-bold tracking-widest text-slate-800 bg-slate-50 px-4 py-1.5 rounded-lg border border-slate-200 select-all">
                {roomCode}
              </span>
              <button
                onClick={handleCopyRoomCode}
                className="p-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 transition-colors"
                title="Copy Code"
              >
                {copiedCode ? <Check className="w-4 h-4 text-sage-600" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div className="flex items-center justify-center gap-2 text-xs text-slate-500 pt-1">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-sage-600" />
            <span>Waiting for friend to connect...</span>
          </div>

          <div className="pt-2">
            <button
              onClick={handleDisconnect}
              className="btn-secondary text-xs py-1.5 px-4"
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
        <div className="glass-panel p-8 text-center max-w-sm mx-auto space-y-4 animate-scale-up">
          <div className="w-10 h-10 rounded-xl bg-sage-50 border border-sage-200 flex items-center justify-center text-sage-600 mx-auto">
            <RefreshCw className="w-5 h-5 animate-spin" />
          </div>

          <div className="space-y-1">
            <h3 className="text-base font-semibold text-slate-900">
              {verifiedPeer ? `Connecting to ${verifiedPeer.fingerprint.slice(0, 8)}...` : 'Connecting...'}
            </h3>
            <p className="text-xs text-slate-500">
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
      {/* 5. CONNECTED CHAT SCREEN (Clean Speech-Bubble Messenger Style)            */}
      {/* ========================================================================= */}
      {status === 'connected' && (
        <div 
          onDragOver={handleDragOver}
          onDragEnter={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`glass-panel overflow-hidden flex flex-col h-[650px] relative transition-all bg-white border border-slate-200/90 shadow-sm ${
            isDraggingOver ? 'ring-2 ring-sage-500 bg-sage-50/20' : ''
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
            <div className="absolute inset-0 z-50 bg-white/95 backdrop-blur-sm border-2 border-dashed border-sage-500 rounded-2xl flex flex-col items-center justify-center p-6 space-y-2 pointer-events-none animate-fade-in">
              <UploadCloud className="w-10 h-10 text-sage-600 animate-bounce" />
              <h3 className="text-sm font-bold text-slate-900">Drop file to send</h3>
              <p className="text-xs text-slate-500">Encrypted in 16KB blocks (Up to 25MB)</p>
            </div>
          )}

          {/* Thin, Unobtrusive Chat Header Bar */}
          <div className="px-4 py-2.5 bg-white border-b border-slate-200/80 flex items-center justify-between gap-3 shrink-0">
            <div className="flex items-center gap-2.5 min-w-0">
              {/* Peer Avatar */}
              <div className="avatar-badge bg-sage-50 border border-sage-200 text-sage-700 font-mono shadow-xs">
                {verifiedPeer?.fingerprint ? verifiedPeer.fingerprint.slice(0, 2).toUpperCase() : 'P'}
              </div>

              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs sm:text-sm font-bold text-slate-900 truncate">
                    {verifiedPeer?.fingerprint ? `Peer ${verifiedPeer.fingerprint.slice(0, 8)}` : 'Secure Peer'}
                  </span>

                  {/* Single Clean Encrypted Badge with Popover Detail */}
                  <button
                    onClick={() => setShowSecurityModal(true)}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-sage-50 text-sage-700 border border-sage-200 hover:bg-sage-100 transition-colors cursor-pointer"
                    title="Click for security & encryption details"
                  >
                    <Lock className="w-2.5 h-2.5 text-sage-600" />
                    <span>Encrypted</span>
                  </button>

                  {/* Subtle Connection Quality Pill */}
                  {connectionType && (
                    <span className="badge-neutral text-[10px] py-0.2 px-1.5">
                      {connectionType === 'direct' ? '⚡ Direct' : '🖥️ Relay'}
                    </span>
                  )}
                </div>
                <p className="text-[10px] text-slate-400 truncate">Room: {roomCode}</p>
              </div>
            </div>

            <button
              onClick={handleDisconnect}
              className="btn-secondary text-xs py-1 px-2.5 text-slate-500 hover:text-rose-600 hover:border-rose-200 hover:bg-rose-50 shrink-0 transition-colors flex items-center gap-1"
              title="Leave room"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Leave</span>
            </button>
          </div>

          {/* Security Details Modal (When tapping Encrypted badge) */}
          {showSecurityModal && (
            <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in">
              <div className="bg-white rounded-2xl max-w-sm w-full p-5 space-y-4 shadow-xl border border-slate-200 animate-scale-up">
                <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                  <div className="flex items-center gap-2 text-sage-700">
                    <ShieldCheck className="w-5 h-5" />
                    <h3 className="text-sm font-bold text-slate-900">Session Security</h3>
                  </div>
                  <button
                    onClick={() => setShowSecurityModal(false)}
                    className="text-slate-400 hover:text-slate-600"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>

                <div className="space-y-2.5 text-xs text-slate-600">
                  <div className="p-2.5 bg-slate-50 rounded-lg space-y-1">
                    <p className="font-semibold text-slate-800">Symmetric Encryption</p>
                    <p className="font-mono text-[11px] text-slate-600">AES-256-GCM (Fresh 12-byte IV per message)</p>
                  </div>
                  <div className="p-2.5 bg-slate-50 rounded-lg space-y-1">
                    <p className="font-semibold text-slate-800">Digital Signatures</p>
                    <p className="font-mono text-[11px] text-slate-600">ECDSA P-256 (SHA-256 Digest)</p>
                  </div>
                  <div className="p-2.5 bg-slate-50 rounded-lg space-y-1">
                    <p className="font-semibold text-slate-800">Key Agreement</p>
                    <p className="font-mono text-[11px] text-slate-600">ECDH P-256 (Diffie-Hellman Shared Secret)</p>
                  </div>
                  <div className="p-2.5 bg-slate-50 rounded-lg space-y-1">
                    <p className="font-semibold text-slate-800">Ephemeral Storage</p>
                    <p className="text-[11px] text-slate-500">Volatile RAM only. Wiped on leave, tab close, or 30s background blur.</p>
                  </div>
                </div>

                <button
                  onClick={() => setShowSecurityModal(false)}
                  className="btn-secondary w-full py-2 text-xs"
                >
                  Close
                </button>
              </div>
            </div>
          )}

          {/* Main Chat Stream with Speech Bubbles and Avatar Placeholders */}
          <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4 bg-[#f8faf9]">
            {messages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-400 space-y-2.5">
                <div className="w-10 h-10 rounded-full bg-sage-50 border border-sage-200 flex items-center justify-center text-sage-600">
                  <Sparkles className="w-5 h-5" />
                </div>
                <p className="text-xs font-semibold text-slate-700">Encrypted session active</p>
                <p className="text-[11px] text-slate-400 max-w-xs leading-relaxed">
                  Speech bubbles are end-to-end encrypted with AES-256-GCM. Messages self-destruct when closed.
                </p>
              </div>
            ) : (
              messages.map((msg) => {
                const isMe = msg.sender === 'me';
                const remainingSecs = getRemainingSeconds(msg, currentTime);
                const isBurn = msg.burnOnRead;
                const isFile = msg.type === 'file';
                const peerInitial = verifiedPeer?.fingerprint ? verifiedPeer.fingerprint.slice(0, 2).toUpperCase() : 'P';
                const timeStr = msg.timestamp
                  ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                  : '';

                return (
                  <div
                    key={msg.id}
                    className={`flex items-end gap-2.5 ${isMe ? 'justify-end' : 'justify-start'} animate-fade-in ${
                      remainingSecs <= 2 ? 'opacity-40 transition-opacity' : 'opacity-100'
                    }`}
                  >
                    {/* Peer Avatar on the left side of peer bubbles */}
                    {!isMe && (
                      <div 
                        className="avatar-badge bg-slate-100 border border-slate-200 text-slate-700 text-[10px] font-mono shadow-xs mb-0.5"
                        title={verifiedPeer?.fingerprint || 'Peer'}
                      >
                        {peerInitial}
                      </div>
                    )}

                    {/* Speech Bubble Container */}
                    <div
                      className={`relative px-4 py-2.5 sm:px-4.5 sm:py-3 rounded-[18px] max-w-[82%] sm:max-w-[72%] shadow-xs transition-all ${
                        isMe
                          ? 'bg-sage-600 text-white rounded-br-[3px]'
                          : 'bg-white text-slate-900 border border-slate-200/90 rounded-bl-[3px]'
                      }`}
                    >
                      {/* Left Pointer Tail for Peer */}
                      {!isMe && (
                        <svg
                          className="absolute -left-1.5 bottom-0 w-2.5 h-3.5 pointer-events-none"
                          viewBox="0 0 10 14"
                          fill="none"
                          xmlns="http://www.w3.org/2000/svg"
                          aria-hidden="true"
                        >
                          <path
                            d="M10 0 C10 6 7 14 0 14 C4.5 14 10 10.5 10 6.5 Z"
                            fill="#ffffff"
                          />
                          <path
                            d="M10 0 C10 6 7 14 0 14"
                            stroke="#e2e8f0"
                            strokeWidth="1"
                          />
                        </svg>
                      )}

                      {/* Right Pointer Tail for Me */}
                      {isMe && (
                        <svg
                          className="absolute -right-1.5 bottom-0 w-2.5 h-3.5 pointer-events-none"
                          viewBox="0 0 10 14"
                          fill="none"
                          xmlns="http://www.w3.org/2000/svg"
                          aria-hidden="true"
                        >
                          <path
                            d="M0 0 C0 6 3 14 10 14 C5.5 14 0 10.5 0 6.5 Z"
                            fill="#5a846a"
                          />
                        </svg>
                      )}

                      {/* Content: File or Text */}
                      {isFile ? (
                        /* File Message inside unified speech bubble */
                        <div className="space-y-2 min-w-[200px] sm:min-w-[240px]">
                          <div className="flex items-start gap-2.5">
                            <div className={`p-2 rounded-xl shrink-0 ${
                              isMe ? 'bg-white/20 text-white' : 'bg-slate-100 border border-slate-200 text-slate-700'
                            }`}>
                              {msg.status === 'completed' ? (
                                <FileText className="w-4.5 h-4.5" />
                              ) : (
                                <Loader2 className="w-4.5 h-4.5 animate-spin" />
                              )}
                            </div>

                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-semibold truncate" title={msg.fileName}>
                                {msg.fileName}
                              </p>
                              <span className={`text-[10px] ${isMe ? 'text-sage-100' : 'text-slate-500'}`}>
                                {formatFileSize(msg.fileSize)}
                              </span>
                            </div>
                          </div>

                          {/* Transfer progress or Download Button */}
                          {msg.status === 'transferring' ? (
                            <div className="space-y-1 pt-1">
                              <div className={`w-full h-1.5 rounded-full overflow-hidden ${isMe ? 'bg-black/20' : 'bg-slate-200'}`}>
                                <div
                                  className={`h-full transition-all duration-150 ${isMe ? 'bg-white' : 'bg-sage-500'}`}
                                  style={{ width: `${msg.progress || 0}%` }}
                                />
                              </div>
                            </div>
                          ) : msg.status === 'completed' && msg.blobUrl ? (
                            <div className="pt-1">
                              <a
                                href={msg.blobUrl}
                                download={msg.fileName}
                                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold transition-all ${
                                  isMe
                                    ? 'bg-white text-sage-800 hover:bg-slate-100 shadow-xs'
                                    : 'bg-sage-600 text-white hover:bg-sage-700 shadow-xs'
                                }`}
                              >
                                <Download className="w-3 h-3" />
                                <span>Download</span>
                              </a>
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        /* Text Message */
                        <p className="text-xs sm:text-sm leading-relaxed whitespace-pre-wrap break-words">
                          {msg.text}
                        </p>
                      )}

                      {/* Subtle Timestamp and Burn Countdown Info */}
                      <div className={`flex items-center justify-end gap-1.5 text-[10px] mt-1 ${
                        isMe ? 'text-sage-200' : 'text-slate-400'
                      }`}>
                        {timeStr && <span>{timeStr}</span>}
                        {timeStr && (isBurn || remainingSecs < DEFAULT_TTL_SECONDS) && <span>•</span>}
                        {isBurn ? (
                          <span className={`inline-flex items-center gap-0.5 font-medium ${
                            isMe ? 'text-amber-200' : 'text-amber-600'
                          }`}>
                            <Flame className="w-2.5 h-2.5" />
                            <span>{remainingSecs}s</span>
                          </span>
                        ) : remainingSecs < DEFAULT_TTL_SECONDS ? (
                          <span>{remainingSecs}s</span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Staged File Preview Bar */}
          {attachedFile && (
            <div className="px-4 py-2 bg-slate-50 border-t border-slate-200/80 flex items-center justify-between gap-3 text-xs animate-slide-up">
              <div className="flex items-center gap-2 min-w-0">
                <div className="p-1.5 rounded-lg bg-white border border-slate-200 text-slate-700 shrink-0">
                  <File className="w-3.5 h-3.5" />
                </div>
                <span className="font-medium text-slate-800 truncate max-w-[180px] sm:max-w-xs">{attachedFile.name}</span>
                <span className="text-slate-400 shrink-0">({formatFileSize(attachedFile.size)})</span>
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => setFileBurnOnRead(!fileBurnOnRead)}
                  className={`px-2 py-0.5 rounded-full text-[10px] flex items-center gap-1 border transition-colors ${
                    fileBurnOnRead
                      ? 'bg-amber-50 border-amber-200 text-amber-700'
                      : 'bg-white border-slate-200 text-slate-500'
                  }`}
                  title="Burn file on view"
                >
                  <Flame className="w-2.5 h-2.5" />
                  <span>Burn</span>
                </button>

                <button
                  onClick={() => setAttachedFile(null)}
                  className="p-1 text-slate-400 hover:text-slate-600"
                  title="Cancel attachment"
                >
                  <X className="w-3.5 h-3.5" />
                </button>

                <button
                  onClick={handleSendAttachedFile}
                  disabled={isSendingFile}
                  className="btn-primary text-xs py-1 px-2.5 flex items-center gap-1 rounded-full"
                >
                  {isSendingFile ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                  <span>Send</span>
                </button>
              </div>
            </div>
          )}

          {/* Clean Rounded Pill Input Bar */}
          <div className="p-3 bg-white border-t border-slate-200/80 shrink-0">
            <form onSubmit={handleSendMessage} className="flex items-center gap-2">
              <div className="chat-input-pill flex-1 flex items-center gap-1.5 px-2 py-1">
                {/* Paperclip File Attachment Button */}
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="p-1.5 rounded-full text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 transition-colors shrink-0"
                  title="Attach File (Encrypted P2P)"
                >
                  <Paperclip className="w-4 h-4" />
                </button>

                {/* Burn On Read Flame Toggle */}
                <button
                  type="button"
                  onClick={() => setBurnOnReadEnabled(!burnOnReadEnabled)}
                  className={`p-1.5 rounded-full transition-colors shrink-0 ${
                    burnOnReadEnabled
                      ? 'bg-amber-100 text-amber-600'
                      : 'text-slate-400 hover:text-slate-600 hover:bg-slate-200/60'
                  }`}
                  title="Burn on Read: Message self-destructs 5s after viewing"
                >
                  <Flame className="w-4 h-4" />
                </button>

                {/* Input Text Field */}
                <input
                  type="text"
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  placeholder="Type an encrypted message..."
                  className="flex-1 bg-transparent border-none outline-none text-xs sm:text-sm text-slate-900 placeholder:text-slate-400 px-1 py-1"
                />
              </div>

              {/* Circular Send Action Button */}
              <button
                type="submit"
                disabled={!inputText.trim()}
                className="w-9 h-9 rounded-full bg-sage-600 hover:bg-sage-700 text-white flex items-center justify-center shrink-0 shadow-xs transition-all active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-sage-600 cursor-pointer"
                title="Send encrypted message"
              >
                <Send className="w-4 h-4 ml-0.5" />
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
