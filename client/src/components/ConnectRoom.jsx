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
  const [previewImage, setPreviewImage] = useState(null); // Lightbox photo preview state

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

  // Trigger burn on file interaction (opening preview or downloading)
  const handleTriggerFileBurn = (msgId) => {
    setMessages((prev) =>
      prev.map((msg) => {
        if (msg.id === msgId && msg.burnOnRead && !msg.burnDeadline) {
          return {
            ...msg,
            renderedAt: Date.now(),
            burnDeadline: Date.now() + (msg.burnDelay || BURN_ON_READ_DELAY_SECONDS) * 1000,
          };
        }
        return msg;
      })
    );
  };

  // Burn-on-Read: Activate countdown for text messages when rendered
  useEffect(() => {
    setMessages((prev) => {
      let updated = false;
      const now = Date.now();

      const next = prev.map((msg) => {
        if (msg.sender === 'peer' && msg.burnOnRead && !msg.burnDeadline) {
          // For text messages, trigger on render
          if (!msg.type || msg.type === 'text') {
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
  }, [messages]);

  const isSelectingFileRef = useRef(false);

  const handleOpenFilePicker = () => {
    isSelectingFileRef.current = true;
    fileInputRef.current?.click();
    // Keep flag true for up to 2 minutes while user browses mobile file manager
    setTimeout(() => {
      isSelectingFileRef.current = false;
    }, 120000);
  };

  // Anti-Persistence Guard: Window Blur & Tab Close Auto-Purge
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        if (isSelectingFileRef.current) {
          console.log('[Mobile] File picker active, skipping background blur purge.');
          return;
        }
        blurTimerRef.current = setTimeout(() => {
          if (sessionRef.current) {
            sessionRef.current.cleanup(true);
          }
          messagesRef.current.forEach(revokeFileBlobUrl);
          setMessages([]);
          setAttachedFile(null);
          setStatus('disconnected');
          setStatusDetails({
            message: 'Session wiped: Inactive for over 3 minutes.',
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
      if (isSelectingFileRef.current) {
        // Mobile Android Chrome fires beforeunload speculatively when opening native file manager
        return;
      }
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
      if (sessionRef.current && !isSelectingFileRef.current) {
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
      } catch (err) {
        console.warn('Error clearing scanner:', err);
      }
      html5QrScannerRef.current = null;
    }

    // Explicitly release any media stream tracks and clear container
    const container = document.getElementById(scannerContainerId);
    if (container) {
      const videos = container.querySelectorAll('video');
      videos.forEach((video) => {
        if (video.srcObject && typeof video.srcObject.getTracks === 'function') {
          video.srcObject.getTracks().forEach((track) => track.stop());
        }
      });
      container.innerHTML = '';
    }

    setIsJoinScannerOpen(false);
    setCameraError(null);
  };

  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === 'Escape' && isJoinScannerOpen) {
        stopCameraScanner();
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isJoinScannerOpen]);

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
          experimentalFeatures: {
            useBarCodeDetectorIfSupported: true,
          },
        });
        html5QrScannerRef.current = scanner;

        const config = {
          fps: 15,
          qrbox: (viewfinderWidth, viewfinderHeight) => {
            const minEdge = Math.min(viewfinderWidth, viewfinderHeight);
            const size = Math.max(220, Math.floor(minEdge * 0.85));
            return { width: size, height: size };
          },
          aspectRatio: 1.0,
        };
        const successCb = (decodedText) => handleQrScanSuccess(decodedText);
        const errorCb = () => {};

        let cameraDeviceOrConfig = { facingMode: 'environment' };
        try {
          const devices = await Html5Qrcode.getCameras();
          if (devices && devices.length > 0) {
            const backCamera = devices.find((d) =>
              /back|rear|environment/i.test(d.label)
            );
            cameraDeviceOrConfig = backCamera ? backCamera.id : devices[0].id;
          }
        } catch {
          // Fall back to constraint
        }

        try {
          await scanner.start(cameraDeviceOrConfig, config, successCb, errorCb);
        } catch (firstErr) {
          await scanner.start({ facingMode: 'user' }, config, successCb, errorCb);
        }
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
    if (status !== 'connected' || !sessionRef.current) return;

    if (attachedFile && !isSendingFile) {
      await handleSendAttachedFile();
    }

    if (!inputText.trim()) return;

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
      <div 
        id="covert-file-temp-scanner" 
        style={{ position: 'fixed', top: '-9999px', left: '-9999px', width: '250px', height: '250px', opacity: 0, pointerEvents: 'none' }} 
      />

      {/* Top Subtle Config Bar */}
      <div className="flex items-center justify-between text-xs text-slate-400 px-1">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-[#5DD62C] shadow-[0_0_8px_rgba(93,214,44,0.6)]" />
          <span className="font-semibold text-white">Peer-to-Peer Tunnel</span>
        </div>

        <button
          onClick={() => setShowServerConfig(!showServerConfig)}
          className="text-[11px] text-[#5DD62C] hover:text-[#6DE73B] flex items-center gap-1 transition-colors py-1 px-2 rounded-lg hover:bg-[#202020]"
        >
          <Server className="w-3 h-3" />
          <span>Server config</span>
          {showServerConfig ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>
      </div>

      {showServerConfig && (
        <div className="p-4 bg-[#202020] border border-[#337418]/40 rounded-2xl space-y-3 text-xs shadow-xl animate-slide-up">
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
              className="flex-1 bg-[#0F0F0F] border border-[#337418]/50 focus:border-[#5DD62C] rounded-xl px-3 py-2 text-xs text-white placeholder:text-slate-500 font-mono"
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
            <div className="glass-panel p-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border-[#337418]/50 bg-[#202020] shadow-lg">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-[#0F0F0F] border border-[#5DD62C] text-[#5DD62C] shadow-[0_0_10px_rgba(93,214,44,0.25)]">
                  <UserCheck className="w-4 h-4" />
                </div>
                <div>
                  <p className="text-xs font-bold text-white">Paired Peer</p>
                  <p className="text-xs text-[#5DD62C] font-mono">
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
            <div className="glass-panel p-6 sm:p-8 flex flex-col justify-between space-y-6 hover:border-[#5DD62C]/60 hover:shadow-[0_0_20px_rgba(93,214,44,0.15)] transition-all bg-[#202020]">
              <div className="space-y-3">
                <div className="w-12 h-12 rounded-2xl bg-[#0F0F0F] border border-[#5DD62C] flex items-center justify-center text-[#5DD62C] shadow-[0_0_12px_rgba(93,214,44,0.25)]">
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
            <div className="glass-panel p-6 sm:p-8 flex flex-col justify-between space-y-6 hover:border-[#5DD62C]/60 hover:shadow-[0_0_20px_rgba(93,214,44,0.15)] transition-all bg-[#202020]">
              <div className="space-y-3">
                <div className="w-12 h-12 rounded-2xl bg-[#0F0F0F] border border-[#337418] flex items-center justify-center text-[#5DD62C]">
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
                <Camera className="w-4 h-4 text-[#5DD62C]" />
                <span>Join Chat (Scan QR)</span>
              </button>
            </div>
          </div>

          {/* Secondary Outlined Fallback Button */}
          <div className="flex flex-col items-center justify-center pt-2 sm:pt-4">
            <button
              type="button"
              onClick={() => setShowManualPeerInput(!showManualPeerInput)}
              className="inline-flex items-center justify-center gap-2 min-h-[44px] px-5 py-2.5 rounded-xl border border-[#337418]/40 hover:border-[#5DD62C] bg-[#202020] hover:bg-[#282828] text-slate-300 hover:text-white text-xs sm:text-sm font-medium shadow-md transition-all active:scale-[0.98] touch-manipulation focus:outline-none focus-visible:ring-1 focus-visible:ring-[#5DD62C]"
              aria-expanded={showManualPeerInput}
            >
              <FileCode className="w-4 h-4 text-[#5DD62C]" />
              <span>Enter room code or paste JSON manually</span>
              {showManualPeerInput ? (
                <ChevronUp className="w-4 h-4 text-[#5DD62C] ml-0.5" />
              ) : (
                <ChevronDown className="w-4 h-4 text-[#5DD62C] ml-0.5" />
              )}
            </button>
          </div>

          {showManualPeerInput && (
            <div className="glass-panel p-5 space-y-4 max-w-md mx-auto animate-slide-up bg-[#202020] border-[#337418]/50">
              <div className="flex items-center justify-between border-b border-[#303030] pb-2">
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
                    className="flex-1 bg-[#0F0F0F] border border-[#337418]/50 focus:border-[#5DD62C] rounded-xl px-3 py-2 font-mono text-center text-sm font-bold tracking-widest text-[#5DD62C] uppercase"
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

              <form onSubmit={handleManualPeerValidate} className="space-y-2 pt-2 border-t border-[#303030]">
                <label className="text-[11px] font-medium text-slate-400 block">
                  Or Paste Raw Peer Identity JSON:
                </label>
                <textarea
                  rows={2}
                  value={rawPeerJsonInput}
                  onChange={(e) => setRawPeerJsonInput(e.target.value)}
                  placeholder='{"protocol":"covert-chatter",...}'
                  className="w-full bg-[#0F0F0F] border border-[#337418]/50 focus:border-[#5DD62C] rounded-xl p-2.5 text-xs font-mono text-white placeholder:text-slate-600"
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
        <div 
          className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-4 animate-fade-in"
          onClick={(e) => {
            if (e.target === e.currentTarget) stopCameraScanner();
          }}
          role="dialog"
          aria-modal="true"
          aria-label="Scan QR Code"
        >
          <div className="bg-[#202020] rounded-2xl max-w-sm w-full p-5 space-y-4 shadow-2xl border border-[#337418]/60 animate-scale-up relative">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Camera className="w-4 h-4 text-[#5DD62C]" />
                <h3 className="text-sm font-bold text-white">Scan QR Code</h3>
              </div>
              <button
                onClick={stopCameraScanner}
                className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-[#282828]"
                aria-label="Close scanner"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Viewfinder Frame */}
            <div className="relative rounded-xl overflow-hidden bg-black h-[260px] min-h-[260px] max-h-[260px] w-full flex items-center justify-center border border-[#337418]/40">
              <div id={scannerContainerId} className="w-full h-full overflow-hidden rounded-lg flex items-center justify-center" />
              <div className="absolute inset-0 pointer-events-none flex items-center justify-center z-10">
                <div className="w-44 h-44 border-2 border-[#5DD62C] rounded-2xl shadow-[0_0_15px_rgba(93,214,44,0.4)]" />
              </div>
            </div>

            {cameraError && (
              <p className="text-xs text-rose-400 bg-rose-500/10 p-2.5 rounded-xl border border-rose-500/30">
                {cameraError}
              </p>
            )}

            <div className="flex items-center justify-between gap-2 pt-1 border-t border-[#303030]">
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
                <FileImage className="w-3.5 h-3.5 text-[#5DD62C]" />
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
        <div className="glass-panel p-6 sm:p-8 text-center max-w-md mx-auto space-y-5 animate-scale-up bg-[#202020] border-[#337418]/50">
          <div className="space-y-1">
            <span className="badge-neon text-xs">Room Ready</span>
            <h3 className="text-lg font-bold text-white">Show this to your friend</h3>
            <p className="text-xs text-slate-300">
              Scan this code with "Join Chat" to begin
            </p>
          </div>

          <div className="p-3 sm:p-4 bg-white rounded-2xl border-2 border-[#5DD62C] inline-block shadow-[0_0_25px_rgba(93,214,44,0.25)]">
            <QRCodeSVG
              value={hostQrPayload}
              size={250}
              level="L"
              includeMargin={true}
              bgColor="#FFFFFF"
              fgColor="#0F0F0F"
            />
          </div>

          <div className="space-y-1">
            <span className="text-[11px] text-slate-400 uppercase tracking-wider font-semibold">
              Room Code
            </span>
            <div className="flex items-center justify-center gap-2">
              <span className="font-mono text-2xl font-bold tracking-widest text-[#5DD62C] bg-[#0F0F0F] px-5 py-2 rounded-xl border border-[#337418]/50 select-all shadow-[0_0_12px_rgba(93,214,44,0.2)]">
                {roomCode}
              </span>
              <button
                onClick={handleCopyRoomCode}
                className="p-2.5 rounded-xl bg-[#0F0F0F] border border-[#337418]/50 hover:border-[#5DD62C] text-white hover:text-[#5DD62C] transition-all"
                title="Copy Code"
              >
                {copiedCode ? <Check className="w-4 h-4 text-[#5DD62C]" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div className="flex items-center justify-center gap-2 text-xs text-slate-300 pt-1">
            <Loader2 className="w-4 h-4 animate-spin text-[#5DD62C]" />
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
        <div className="glass-panel p-8 text-center max-w-sm mx-auto space-y-4 animate-scale-up bg-[#202020] border-[#337418]/50">
          <div className="w-12 h-12 rounded-2xl bg-[#0F0F0F] border border-[#5DD62C] flex items-center justify-center text-[#5DD62C] mx-auto shadow-[0_0_15px_rgba(93,214,44,0.3)]">
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
      {/* 5. CONNECTED CHAT SCREEN (Exact Dark Neon System)                         */}
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
            className={`rounded-[28px] border border-[#337418]/40 overflow-hidden flex flex-col chat-container-responsive relative transition-all bg-[#0F0F0F] shadow-2xl ${
              isDraggingOver ? 'ring-4 ring-[#5DD62C]/40 bg-[#202020]' : ''
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
              <div className="absolute inset-0 z-50 bg-[#202020]/95 border-2 border-dashed border-[#5DD62C] rounded-[24px] flex flex-col items-center justify-center p-6 space-y-2 pointer-events-none animate-fade-in">
                <UploadCloud className="w-12 h-12 text-[#5DD62C] animate-bounce" />
                <h3 className="text-sm font-bold text-white">Drop file to send</h3>
                <p className="text-xs text-[#5DD62C]">Encrypted in 16KB blocks (Up to 25MB)</p>
              </div>
            )}

            {/* HEADER: #202020 bg, thin #337418 bottom border */}
            <div className="px-5 py-3 bg-[#202020] border-b border-[#337418]/40 flex items-center justify-between gap-3 shrink-0 relative z-20 shadow-md">
              <div className="flex items-center gap-3 min-w-0">
                {/* Peer avatar circle with #5DD62C border */}
                <div className="relative shrink-0">
                  <div 
                    className="chat-avatar-40"
                    title={verifiedPeer?.fingerprint || 'Peer'}
                  >
                    {peerInitials}
                  </div>
                  {/* Glowing Connection status dot */}
                  <span 
                    className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-[#5DD62C] rounded-full border border-[#0F0F0F] shadow-[0_0_8px_rgba(93,214,44,0.8)]"
                    title="Connected"
                  />
                </div>

                {/* Peer Name & Room details */}
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="text-sm sm:text-base font-bold text-white truncate">
                      {peerDisplayName}
                    </h2>

                    {/* Connection status badge */}
                    <button
                      onClick={() => setShowSecurityModal(true)}
                      className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-[#0F0F0F] text-[#5DD62C] border border-[#5DD62C] shadow-[0_0_10px_rgba(93,214,44,0.25)] hover:bg-[#5DD62C]/10 transition-all cursor-pointer"
                      title="Click for security & encryption details"
                    >
                      <Lock className="w-2.5 h-2.5 text-[#5DD62C]" />
                      <span>Encrypted</span>
                    </button>

                    {/* Connection Type Pill */}
                    {connectionType && (
                      <span className="badge-neutral text-[10px] py-0.2 px-1.5">
                        {connectionType === 'direct' ? '⚡ Direct' : '🖥️ Relay'}
                      </span>
                    )}
                  </div>
                  <p className="text-[10px] text-slate-400 font-mono truncate">Room: {roomCode}</p>
                </div>
              </div>

              {/* Right side: small "•••" icon button for options */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowOptionsMenu(!showOptionsMenu)}
                  className="chat-icon-btn w-9 h-9 min-w-[36px] min-h-[36px]"
                  title="Options & Session Settings"
                  aria-label="Options"
                >
                  <MoreHorizontal className="w-4 h-4" />
                </button>

                {/* Options Dropdown Menu */}
                {showOptionsMenu && (
                  <>
                    <div 
                      className="fixed inset-0 z-30" 
                      onClick={() => setShowOptionsMenu(false)} 
                    />
                    <div className="absolute right-0 top-11 z-40 w-56 bg-[#202020] rounded-2xl border border-[#337418] p-2 shadow-2xl space-y-1 animate-scale-up">
                      <div className="px-3 py-2 border-b border-[#303030]">
                        <p className="text-xs font-bold text-white">Session Options</p>
                        <p className="text-[10px] text-slate-400 font-mono truncate">Room: {roomCode}</p>
                      </div>

                      <button
                        type="button"
                        onClick={() => {
                          handleCopyRoomCode();
                          setShowOptionsMenu(false);
                        }}
                        className="w-full text-left px-3 py-2 rounded-xl text-xs text-slate-300 hover:text-[#5DD62C] hover:bg-[#282828] flex items-center gap-2 transition-colors font-medium cursor-pointer"
                      >
                        <Copy className="w-3.5 h-3.5 text-[#5DD62C]" />
                        <span>Copy Room Code</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setShowSecurityModal(true);
                          setShowOptionsMenu(false);
                        }}
                        className="w-full text-left px-3 py-2 rounded-xl text-xs text-slate-300 hover:text-[#5DD62C] hover:bg-[#282828] flex items-center gap-2 transition-colors font-medium cursor-pointer"
                      >
                        <ShieldCheck className="w-3.5 h-3.5 text-[#5DD62C]" />
                        <span>Security & Encryption</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setShowOptionsMenu(false);
                          handleDisconnect();
                        }}
                        className="w-full text-left px-3 py-2 rounded-xl text-xs text-rose-400 hover:bg-rose-500/15 flex items-center gap-2 transition-colors font-semibold cursor-pointer border-t border-[#303030] mt-1"
                      >
                        <Trash2 className="w-3.5 h-3.5 text-rose-400" />
                        <span>Leave Room & Wipe</span>
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Security Details Modal (When triggered from Options) */}
            {showSecurityModal && (
              <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-4 animate-fade-in">
                <div className="bg-[#202020] rounded-2xl max-w-sm w-full p-5 space-y-4 shadow-2xl border border-[#337418] animate-scale-up">
                  <div className="flex items-center justify-between border-b border-[#303030] pb-2">
                    <div className="flex items-center gap-2 text-[#5DD62C]">
                      <ShieldCheck className="w-5 h-5 text-[#5DD62C]" />
                      <h3 className="text-sm font-bold text-white">Session Security</h3>
                    </div>
                    <button
                      onClick={() => setShowSecurityModal(false)}
                      className="p-1 text-slate-400 hover:text-white rounded-lg"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="space-y-2.5 text-xs text-slate-300">
                    <div className="p-2.5 bg-[#0F0F0F] border border-[#337418]/40 rounded-xl space-y-1">
                      <p className="font-bold text-white">Symmetric Encryption</p>
                      <p className="font-mono text-[11px] text-[#5DD62C]">AES-256-GCM (Fresh 12-byte IV per message)</p>
                    </div>
                    <div className="p-2.5 bg-[#0F0F0F] border border-[#337418]/40 rounded-xl space-y-1">
                      <p className="font-bold text-white">Digital Signatures</p>
                      <p className="font-mono text-[11px] text-[#5DD62C]">ECDSA P-256 (SHA-256 Digest)</p>
                    </div>
                    <div className="p-2.5 bg-[#0F0F0F] border border-[#337418]/40 rounded-xl space-y-1">
                      <p className="font-bold text-white">Key Agreement</p>
                      <p className="font-mono text-[11px] text-[#5DD62C]">ECDH P-256 (Diffie-Hellman Shared Secret)</p>
                    </div>
                    <div className="p-2.5 bg-[#0F0F0F] border border-[#337418]/40 rounded-xl space-y-1">
                      <p className="font-bold text-white">Ephemeral Storage</p>
                      <p className="text-[11px] text-slate-400">Volatile RAM only. Wiped on leave, tab close, or 30s background blur.</p>
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

            {/* CHAT BUBBLES STREAM: #0F0F0F bg, 14-16px gap */}
            <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-3.5 sm:space-y-4 bg-[#0F0F0F]">
              {messages.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-400 space-y-3">
                  <div className="w-12 h-12 rounded-full bg-[#202020] border border-[#5DD62C] flex items-center justify-center text-[#5DD62C] shadow-[0_0_15px_rgba(93,214,44,0.3)]">
                    <Sparkles className="w-6 h-6" />
                  </div>
                  <p className="text-sm font-bold text-white">Encrypted tunnel established</p>
                  <p className="text-xs text-slate-400 max-w-xs leading-relaxed">
                    Messages are end-to-end encrypted with AES-256-GCM. Ephemeral RAM storage only.
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
                    // SENT (MY) MESSAGES: Right-aligned, solid #5DD62C fill, #0F0F0F dark text
                    return (
                      <div
                        key={msg.id}
                        className={`flex justify-end items-end gap-2.5 animate-bubble-pop ${
                          remainingSecs <= 2 ? 'opacity-40 transition-opacity' : 'opacity-100'
                        }`}
                      >
                        {/* Outside Left: Countdown Badge & Timestamp */}
                        <div className="flex flex-col items-end gap-1 select-none pb-1 shrink-0">
                          {isBurn ? (
                            <span className="inline-flex items-center gap-1 font-bold text-[10px] text-[#0F0F0F] bg-[#5DD62C] border border-[#5DD62C] px-1.5 py-0.5 rounded-full shadow-[0_0_8px_rgba(93,214,44,0.35)]">
                              <Flame className="w-2.5 h-2.5 text-[#0F0F0F] fill-[#0F0F0F] animate-pulse" />
                              <span>{remainingSecs}s</span>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 font-mono text-[10px] text-[#5DD62C] bg-[#202020] border border-[#337418]/50 px-1.5 py-0.5 rounded-full shadow-xs">
                              <Clock className="w-2.5 h-2.5 text-[#5DD62C]" />
                              <span>{remainingSecs}s</span>
                            </span>
                          )}
                          <div className="flex items-center gap-1 text-[10px] font-mono text-slate-400 font-semibold">
                            <Check className="w-3 h-3 text-[#5DD62C] stroke-[2.5]" />
                            <span>{timeStr}</span>
                          </div>
                        </div>

                        {/* #5DD62C Bubble Container: sizes to content naturally up to 75% */}
                        <div className="max-w-[75%] flex justify-end min-w-0">
                          <div className="bubble-mine">
                            {isFile ? (
                              <div className="space-y-2 min-w-[200px] sm:min-w-[240px]">
                                {msg.status !== 'completed' ? (
                                   <div className="space-y-1.5 pt-1">
                                    <div className="flex items-center justify-between text-[10px] text-[#0F0F0F]/75 font-mono">
                                      <span>{msg.status === 'receiving' ? 'Receiving...' : 'Sending...'}</span>
                                      <span>{msg.progress || 0}%</span>
                                    </div>
                                    <div className="w-full h-2 rounded-full overflow-hidden bg-black/20">
                                      <div
                                        className="h-full transition-all duration-150 bg-[#0F0F0F]"
                                        style={{ width: `${msg.progress || 0}%` }}
                                      />
                                    </div>
                                  </div>
                                ) : msg.blobUrl && msg.mimeType?.startsWith('image/') ? (
                                  /* Inline Photo Preview */
                                  <div className="space-y-1.5">
                                    <div 
                                      className="rounded-xl overflow-hidden bg-black/20 border border-black/10 cursor-pointer max-h-56 max-w-xs group relative"
                                      onClick={() => {
                                        setPreviewImage({ url: msg.blobUrl, name: msg.fileName, size: msg.fileSize, id: msg.id });
                                        handleTriggerFileBurn(msg.id);
                                      }}
                                    >
                                      <img
                                        src={msg.blobUrl}
                                        alt={msg.fileName}
                                        className="w-full h-auto max-h-56 object-cover rounded-xl group-hover:scale-[1.02] transition-transform duration-200"
                                      />
                                    </div>
                                    <div className="flex items-center justify-between gap-2 pt-0.5">
                                      <span className="text-[10px] font-mono text-[#0F0F0F]/75 truncate max-w-[130px]">
                                        {msg.fileName}
                                      </span>
                                      <a
                                        href={msg.blobUrl}
                                        download={msg.fileName}
                                        onClick={() => handleTriggerFileBurn(msg.id)}
                                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-[#0F0F0F] text-white hover:bg-black transition-all shadow-xs"
                                      >
                                        <Download className="w-2.5 h-2.5 text-[#5DD62C]" />
                                        <span>Save</span>
                                      </a>
                                    </div>
                                  </div>
                                ) : (
                                  /* Standard File Card */
                                  <div className="space-y-2">
                                    <div className="flex items-start gap-2.5">
                                      <div className="p-2 rounded-xl bg-black/15 text-[#0F0F0F] shrink-0">
                                        <FileText className="w-4.5 h-4.5" />
                                      </div>
                                      <div className="flex-1 min-w-0">
                                        <p className="text-xs sm:text-sm font-bold text-[#0F0F0F] truncate" title={msg.fileName}>
                                          {msg.fileName}
                                        </p>
                                        <span className="text-[10px] text-[#0F0F0F]/75 font-mono">
                                          {formatFileSize(msg.fileSize)}
                                        </span>
                                      </div>
                                    </div>
                                    {msg.blobUrl && (
                                      <div className="pt-0.5">
                                        <a
                                          href={msg.blobUrl}
                                          download={msg.fileName}
                                          onClick={() => handleTriggerFileBurn(msg.id)}
                                          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-bold bg-[#0F0F0F] text-white hover:bg-black transition-all shadow-md"
                                        >
                                          <Download className="w-3 h-3 text-[#5DD62C]" />
                                          <span>Download</span>
                                        </a>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <p className="text-[15px] sm:text-[16px] leading-relaxed font-normal whitespace-pre-wrap text-[#0F0F0F] m-0">
                                {msg.text}
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  } else {
                    // RECEIVED (PEER) MESSAGES: Left-aligned, solid #F8F8F8 fill, #0F0F0F dark text
                    return (
                      <div
                        key={msg.id}
                        className={`flex items-end gap-2.5 animate-bubble-pop ${
                          remainingSecs <= 2 ? 'opacity-40 transition-opacity' : 'opacity-100'
                        }`}
                      >
                        {/* Peer Avatar (Aligned to baseline) */}
                        <div 
                          className="w-8 h-8 min-w-[32px] min-h-[32px] rounded-full border border-[#337418] bg-[#202020] text-[#F8F8F8] font-bold text-xs flex items-center justify-center font-mono select-none shrink-0"
                          title={verifiedPeer?.fingerprint || 'Peer'}
                        >
                          {peerInitials}
                        </div>

                        {/* Message Stack */}
                        <div className="flex flex-col items-start max-w-[75%] min-w-0">
                          <span className="text-[11px] font-bold text-slate-300 ml-1 mb-1 select-none">
                            {peerDisplayName}
                          </span>

                          <div className="flex items-end gap-2.5">
                            {/* #F8F8F8 Bubble Container: sizes to content naturally up to 75% */}
                            <div className="bubble-peer">
                              {isFile ? (
                                <div className="space-y-2 min-w-[200px] sm:min-w-[240px]">
                                  {msg.status !== 'completed' ? (
                                    <div className="space-y-1.5 pt-1">
                                      <div className="flex items-center justify-between text-[10px] text-[#0F0F0F]/75 font-mono">
                                        <span>Receiving...</span>
                                        <span>{msg.progress || 0}%</span>
                                      </div>
                                      <div className="w-full h-2 rounded-full overflow-hidden bg-black/20">
                                        <div
                                          className="h-full transition-all duration-150 bg-[#0F0F0F]"
                                          style={{ width: `${msg.progress || 0}%` }}
                                        />
                                      </div>
                                    </div>
                                  ) : msg.blobUrl && msg.mimeType?.startsWith('image/') ? (
                                    /* Inline Photo Preview for Peer */
                                    <div className="space-y-1.5">
                                      <div 
                                        className="rounded-xl overflow-hidden bg-black/20 border border-black/10 cursor-pointer max-h-56 max-w-xs group relative"
                                        onClick={() => {
                                          setPreviewImage({ url: msg.blobUrl, name: msg.fileName, size: msg.fileSize, id: msg.id });
                                          handleTriggerFileBurn(msg.id);
                                        }}
                                      >
                                        <img
                                          src={msg.blobUrl}
                                          alt={msg.fileName}
                                          className="w-full h-auto max-h-56 object-cover rounded-xl group-hover:scale-[1.02] transition-transform duration-200"
                                        />
                                      </div>
                                      <div className="flex items-center justify-between gap-2 pt-0.5">
                                        <span className="text-[10px] font-mono text-[#0F0F0F]/75 truncate max-w-[130px]">
                                          {msg.fileName}
                                        </span>
                                        <a
                                          href={msg.blobUrl}
                                          download={msg.fileName}
                                          onClick={() => handleTriggerFileBurn(msg.id)}
                                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-[#0F0F0F] text-white hover:bg-black transition-all shadow-xs"
                                        >
                                          <Download className="w-2.5 h-2.5 text-[#5DD62C]" />
                                          <span>Save</span>
                                        </a>
                                      </div>
                                    </div>
                                  ) : (
                                    /* Standard File Card for Peer */
                                    <div className="space-y-2">
                                      <div className="flex items-start gap-2.5">
                                        <div className="p-2 rounded-xl bg-black/15 text-[#0F0F0F] shrink-0">
                                          <FileText className="w-4.5 h-4.5" />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                          <p className="text-xs sm:text-sm font-bold text-[#0F0F0F] truncate" title={msg.fileName}>
                                            {msg.fileName}
                                          </p>
                                          <span className="text-[10px] text-[#0F0F0F]/75 font-mono">
                                            {formatFileSize(msg.fileSize)}
                                          </span>
                                        </div>
                                      </div>
                                      {msg.blobUrl && (
                                        <div className="pt-0.5">
                                          <a
                                            href={msg.blobUrl}
                                            download={msg.fileName}
                                            onClick={() => handleTriggerFileBurn(msg.id)}
                                            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-bold bg-[#0F0F0F] text-white hover:bg-black transition-all shadow-md"
                                          >
                                            <Download className="w-3 h-3 text-[#5DD62C]" />
                                            <span>Download</span>
                                          </a>
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <p className="text-[15px] sm:text-[16px] leading-relaxed font-normal whitespace-pre-wrap text-[#0F0F0F] m-0">
                                  {msg.text}
                                </p>
                              )}
                            </div>

                            {/* Outside Right: Countdown Badge & Timestamp */}
                            <div className="flex flex-col items-start gap-1 select-none pb-1 shrink-0">
                              {isBurn ? (
                                <span className="inline-flex items-center gap-1 font-bold text-[10px] text-[#0F0F0F] bg-[#5DD62C] border border-[#5DD62C] px-1.5 py-0.5 rounded-full shadow-[0_0_8px_rgba(93,214,44,0.35)]">
                                  <Flame className="w-2.5 h-2.5 text-[#0F0F0F] fill-[#0F0F0F] animate-pulse" />
                                  <span>{remainingSecs}s</span>
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 font-mono text-[10px] text-[#5DD62C] bg-[#202020] border border-[#337418]/50 px-1.5 py-0.5 rounded-full shadow-xs">
                                  <Clock className="w-2.5 h-2.5 text-[#5DD62C]" />
                                  <span>{remainingSecs}s</span>
                                </span>
                              )}
                              <span className="text-[10px] font-mono text-slate-400 font-semibold">{timeStr}</span>
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
              <div className="px-4 py-2.5 bg-[#202020] border-t border-[#337418]/40 flex items-center justify-between gap-3 text-xs animate-slide-up">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-7 h-7 rounded-full border border-[#5DD62C] bg-[#0F0F0F] flex items-center justify-center text-[#5DD62C] shrink-0">
                    <File className="w-3.5 h-3.5" />
                  </div>
                  <span className="font-bold text-white truncate max-w-[180px] sm:max-w-xs">{attachedFile.name}</span>
                  <span className="text-slate-400 shrink-0 font-mono">({formatFileSize(attachedFile.size)})</span>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => setFileBurnOnRead(!fileBurnOnRead)}
                    className={`px-2.5 py-1 rounded-full text-[11px] font-bold flex items-center gap-1 border transition-colors cursor-pointer ${
                      fileBurnOnRead
                        ? 'bg-[#5DD62C] text-[#0F0F0F] border-[#5DD62C] shadow-[0_0_8px_rgba(93,214,44,0.3)]'
                        : 'bg-[#0F0F0F] text-slate-300 border-[#337418]/50 hover:border-[#5DD62C]'
                    }`}
                    title="Burn file on read"
                  >
                    <Flame className="w-3 h-3" />
                    <span>Burn</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setAttachedFile(null)}
                    className="w-7 h-7 rounded-full border border-slate-600 bg-[#0F0F0F] hover:bg-[#282828] text-slate-300 flex items-center justify-center cursor-pointer"
                    title="Cancel attachment"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>

                  <button
                    type="button"
                    onClick={handleSendAttachedFile}
                    disabled={isSendingFile}
                    className="btn-primary text-xs py-1 px-3 flex items-center gap-1.5 rounded-full disabled:opacity-40"
                  >
                    {isSendingFile ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                    <span>Send</span>
                  </button>
                </div>
              </div>
            )}

            {/* FOOTER: #202020 bar, input with #0F0F0F bg + #337418 border + white text, #5DD62C send button */}
            <div className="p-3 sm:p-4 bg-[#202020] border-t border-[#337418]/40 shrink-0 shadow-lg">
              <form onSubmit={handleSendMessage} className="flex items-center gap-2 sm:gap-3">
                {/* Left: Attach icon button */}
                <button
                  type="button"
                  onClick={handleOpenFilePicker}
                  className="chat-icon-btn w-10 h-10 min-w-[40px] min-h-[40px]"
                  title="Attach File or Photo (Encrypted P2P)"
                  aria-label="Attach file"
                >
                  <Paperclip className="w-5 h-5 text-[#5DD62C] hover:text-[#6DE73B]" />
                </button>

                {/* Text input: #0F0F0F bg, #337418 border, white text, rounded pill shape */}
                <div className="flex-1 bg-[#0F0F0F] border border-[#337418] focus-within:border-[#5DD62C] focus-within:shadow-[0_0_10px_rgba(93,214,44,0.2)] rounded-full px-4 h-10 transition-all flex items-center">
                  <input
                    type="text"
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    placeholder={attachedFile ? "Add a message or press send..." : "Type an encrypted message..."}
                    className="w-full bg-transparent border-none outline-none text-[15px] sm:text-[16px] text-white placeholder:text-slate-500 py-1"
                  />
                </div>

                {/* Right: row of icon buttons (burn-toggle, circular send button) */}
                <div className="flex items-center gap-2 shrink-0">
                  {/* Burn-toggle icon button */}
                  <button
                    type="button"
                    onClick={() => setBurnOnReadEnabled(!burnOnReadEnabled)}
                    className={`chat-icon-btn w-10 h-10 min-w-[40px] min-h-[40px] ${
                      burnOnReadEnabled
                        ? 'bg-[#5DD62C] text-[#0F0F0F] border-[#5DD62C] shadow-[0_0_14px_rgba(93,214,44,0.4)]'
                        : ''
                    }`}
                    title={burnOnReadEnabled ? 'Burn on Read: Active (5s)' : 'Turn on Burn-on-Read'}
                    aria-label="Toggle burn on read"
                  >
                    <Flame className={`w-5 h-5 ${burnOnReadEnabled ? 'fill-[#0F0F0F] text-[#0F0F0F]' : ''}`} />
                  </button>

                  {/* Circular send button */}
                  <button
                    type="submit"
                    disabled={!inputText.trim() && !attachedFile}
                    className="chat-send-btn w-10 h-10 min-w-[40px] min-h-[40px]"
                    title="Send encrypted message or file"
                    aria-label="Send message"
                  >
                    <Send className="w-4 h-4 ml-0.5 text-[#0F0F0F]" />
                  </button>
                </div>
              </form>
            </div>
          </div>
        );
      })()}

      {/* Image Lightbox Preview Modal */}
      {previewImage && (
        <div 
          className="fixed inset-0 z-50 bg-black/90 backdrop-blur-md flex flex-col items-center justify-center p-4 animate-fade-in"
          onClick={() => setPreviewImage(null)}
        >
          <div 
            className="relative max-w-2xl w-full flex flex-col items-center gap-3 animate-scale-up"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Top Bar */}
            <div className="w-full flex items-center justify-between px-2 text-xs">
              <span className="text-white font-bold truncate max-w-xs">{previewImage.name}</span>
              <div className="flex items-center gap-2">
                <a
                  href={previewImage.url}
                  download={previewImage.name}
                  className="btn-primary text-xs py-1.5 px-3 flex items-center gap-1.5 rounded-full"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download</span>
                </a>
                <button
                  onClick={() => setPreviewImage(null)}
                  className="w-8 h-8 rounded-full bg-[#202020] border border-[#337418]/40 text-white hover:bg-[#282828] flex items-center justify-center cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Image display */}
            <div className="rounded-2xl overflow-hidden border border-[#337418]/50 bg-[#0F0F0F] shadow-2xl max-h-[75vh] flex items-center justify-center">
              <img
                src={previewImage.url}
                alt={previewImage.name}
                className="max-h-[75vh] max-w-full object-contain rounded-2xl"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
