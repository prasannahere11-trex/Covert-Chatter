import React, { useState, useEffect, useRef } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';
import { 
  Radio, 
  Copy, 
  Check, 
  Send, 
  LogOut, 
  Users, 
  ShieldCheck, 
  AlertCircle, 
  Lock, 
  Sparkles, 
  Zap, 
  RefreshCw, 
  Server, 
  ChevronDown, 
  ChevronUp, 
  MessageSquare, 
  KeyRound, 
  QrCode, 
  FileCode,
  Flame,
  Clock,
  Trash2,
  ShieldAlert,
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
  CameraOff,
  FileImage,
  ArrowRight,
  UserCheck,
  RotateCcw
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

/**
 * 🔒 ZERO PERSISTENCE SECURITY INVARIANT:
 * ---------------------------------------
 * All chat messages and streaming file buffers are stored solely in transient React RAM.
 * They are NEVER written to localStorage, sessionStorage, IndexedDB, or server logs.
 * Leaving the room, closing the tab, or switching away for > 30 seconds triggers an immediate memory wipe
 * and revokes all in-memory Blob URLs (`URL.revokeObjectURL`).
 */

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

  // Simplified 1-Screen Pairing States
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

  // Pass 5 File Sharing States
  const [attachedFile, setAttachedFile] = useState(null);
  const [fileTtlSeconds, setFileTtlSeconds] = useState(DEFAULT_FILE_TTL_SECONDS); // 180s (3m) default
  const [fileBurnOnRead, setFileBurnOnRead] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [isSendingFile, setIsSendingFile] = useState(false);

  // Pass 6 Connection Quality State ('direct' | 'relay' | null)
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

  // Helper to save paired peer in current browser session
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

  // Auto-scroll chat to bottom
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Pass 6: Check connection quality / candidate pair type (Direct vs Relayed via TURN)
  // Note: Even in "Relayed" mode, the TURN server only sees encrypted ciphertext,
  // never plaintext — the E2EE from Pass 3 still fully applies.
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

  // 1-Second Ticking & Ephemeral Garbage Collection Loop (Messages + Files)
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      setCurrentTime(now);

      // Purge expired messages from volatile memory and revoke Blob URLs
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

  // Burn-on-Read: Activate countdown when recipient first renders the message or file
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
            message: 'Session wiped: Tab remained in background for over 30 seconds.',
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

  // Camera Scanner Lifecycle
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
          { fps: 12, qrbox: { width: 250, height: 250 }, aspectRatio: 1.0 },
          (decodedText) => handleQrScanSuccess(decodedText),
          () => {} // Suppress noise
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

  // Automated Unified Scan Handler: Chains validation -> pairing -> join -> E2EE derivation
  const handleQrScanSuccess = async (decodedText) => {
    try {
      const validation = await validatePeerIdentityPayload(decodedText);
      if (!validation.valid || !validation.peerIdentity) {
        onShowToast(validation.error || 'Invalid QR identity payload', 'error');
        return;
      }

      const peer = validation.peerIdentity;
      onSetVerifiedPeer(peer);
      saveSessionPeer(peer);
      await stopCameraScanner();

      // If room code is embedded in the unified QR, join room automatically!
      if (peer.room) {
        onShowToast(`Linked identity & joining room ${peer.room}...`, 'success');
        await handleDirectJoinRoom(peer.room, peer);
      } else {
        onShowToast('Peer identity linked! Enter the 6-character room code to connect.', 'info');
      }
    } catch (err) {
      onShowToast(`Scan processing error: ${err.message}`, 'error');
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
      onShowToast('Could not find a valid QR code in this image.', 'warning');
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
        onShowToast('Peer identity verified and linked!', 'success');
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
            onShowToast('🔒 Direct E2EE WebRTC DataChannel established!', 'success');
          } else if (newStatus === 'disconnected') {
            messagesRef.current.forEach(revokeFileBlobUrl);
            setMessages([]);
            setAttachedFile(null);
            onShowToast(details?.message || 'Peer disconnected — memory purged', 'warning');
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

  // Host: Tap "Start Chat"
  const handleStartChat = async () => {
    messagesRef.current.forEach(revokeFileBlobUrl);
    setMessages([]);
    setRoomCode('');
    const session = initSession(verifiedPeer);
    if (session) {
      await session.createRoom();
    }
  };

  // Guest: Tap "Join Chat"
  const handleJoinChatClick = () => {
    startCameraScanner();
  };

  // Direct Join
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

  // File Handling
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
      onShowToast('File encrypted & sent successfully!', 'success');
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
    onShowToast('Disconnected from room — all memory wiped', 'info');
  };

  const handleCopyRoomCode = async () => {
    if (!roomCode) return;
    try {
      await navigator.clipboard.writeText(roomCode);
      setCopiedCode(true);
      onShowToast(`Room code ${roomCode} copied!`, 'success');
      setTimeout(() => setCopiedCode(false), 2000);
    } catch {
      onShowToast('Failed to copy', 'error');
    }
  };

  // Construct unified QR payload for Host (includes identity + room code)
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

      {/* Top Signaling Configuration Bar (Collapsible) */}
      <div className="flex items-center justify-between px-2">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          <span className="text-xs font-semibold text-slate-300">Covert Chatter E2EE Network</span>
        </div>

        <button
          onClick={() => setShowServerConfig(!showServerConfig)}
          className="text-[11px] text-slate-400 hover:text-cyan-400 flex items-center gap-1 transition-colors"
        >
          <Server className="w-3 h-3" />
          <span>Server: {customServerUrl.replace(/^wss?:\/\//, '')}</span>
          {showServerConfig ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
        </button>
      </div>

      {showServerConfig && (
        <div className="p-3.5 bg-slate-900/90 border border-slate-800 rounded-xl space-y-2 animate-slide-up text-xs">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-slate-300">Signaling Server URL</span>
            <span className="text-[11px] text-emerald-400">Default: {getDefaultSignalingUrl()}</span>
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={customServerUrl}
              onChange={(e) => setCustomServerUrl(e.target.value)}
              disabled={status !== 'idle' && status !== 'disconnected' && status !== 'error'}
              placeholder={getDefaultSignalingUrl()}
              className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 font-mono text-emerald-300 focus:outline-none focus:border-emerald-500"
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
      {/* 1. LOBBY STATE (Unified 1-Screen Pairing Hub)                            */}
      {/* ========================================================================= */}
      {status === 'idle' || status === 'disconnected' || status === 'error' ? (
        <div className="space-y-6">
          {/* Quick Reconnect Card (If peer is remembered in current browser session) */}
          {savedPeer && (
            <div className="glass-panel p-4 rounded-2xl border-emerald-500/30 bg-emerald-950/10 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 animate-slide-up">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400">
                  <UserCheck className="w-5 h-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-white">Paired Peer Memory</span>
                    <span className="badge-emerald text-[10px]">Session Paired</span>
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Fingerprint: <strong className="font-mono text-cyan-300">{savedPeer.fingerprint.slice(0, 16)}...</strong>
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 w-full sm:w-auto">
                <button
                  onClick={handleStartChat}
                  className="btn-primary text-xs py-1.5 px-3 flex-1 sm:flex-initial flex items-center justify-center gap-1.5"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Start Chat with Peer</span>
                </button>
                <button
                  onClick={clearSessionPeer}
                  className="btn-secondary text-xs py-1.5 px-2.5 text-slate-400 hover:text-rose-400"
                  title="Forget remembered peer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}

          {/* Main 2-Action Pairing Cards: Start Chat vs Join Chat */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Card 1: Start Chat (Host) */}
            <div className="glass-panel p-6 sm:p-8 rounded-2xl flex flex-col justify-between space-y-6 border-emerald-500/30 hover:border-emerald-500/60 transition-all shadow-xl shadow-emerald-950/20 group">
              <div className="space-y-3">
                <div className="w-14 h-14 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shadow-lg shadow-emerald-950/40 group-hover:scale-105 transition-transform">
                  <Sparkles className="w-7 h-7" />
                </div>
                <h3 className="text-xl font-black text-white">Start Chat</h3>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Host an ephemeral E2EE room. Generates a unified QR code containing your cryptographic keys and room invite for your friend to scan.
                </p>
              </div>

              <button
                onClick={handleStartChat}
                className="btn-primary w-full py-3.5 text-sm font-bold flex items-center justify-center gap-2 shadow-lg shadow-emerald-950/40"
              >
                <QrCode className="w-4 h-4" />
                <span>Start Chat & Show QR</span>
              </button>
            </div>

            {/* Card 2: Join Chat (Guest) */}
            <div className="glass-panel p-6 sm:p-8 rounded-2xl flex flex-col justify-between space-y-6 border-cyan-500/30 hover:border-cyan-500/60 transition-all shadow-xl shadow-cyan-950/20 group">
              <div className="space-y-3">
                <div className="w-14 h-14 rounded-2xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400 shadow-lg shadow-cyan-950/40 group-hover:scale-105 transition-transform">
                  <Camera className="w-7 h-7" />
                </div>
                <h3 className="text-xl font-black text-white">Join Chat</h3>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Open your camera to scan your friend's QR code. Automatically links keys, joins the room, and derives the E2EE session key in one step.
                </p>
              </div>

              <button
                onClick={handleJoinChatClick}
                className="btn-secondary w-full py-3.5 text-sm font-bold flex items-center justify-center gap-2 border-cyan-500/40 hover:border-cyan-400 text-cyan-200"
              >
                <Camera className="w-4 h-4 text-cyan-400" />
                <span>Join Chat (Scan QR)</span>
              </button>
            </div>
          </div>

          {/* Fallback Section: Manual Code / JSON Payload Entry */}
          <div className="text-center pt-2">
            <button
              onClick={() => setShowManualPeerInput(!showManualPeerInput)}
              className="text-xs text-slate-400 hover:text-cyan-400 inline-flex items-center gap-1.5 transition-colors underline-offset-4 hover:underline"
            >
              <FileCode className="w-3.5 h-3.5 text-cyan-400" />
              <span>Enter 6-char room code or paste identity JSON manually</span>
            </button>
          </div>

          {showManualPeerInput && (
            <div className="glass-panel p-6 rounded-2xl border-slate-800 space-y-4 animate-slide-up max-w-xl mx-auto">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <h4 className="text-xs font-bold text-slate-200 flex items-center gap-2">
                  <KeyRound className="w-4 h-4 text-cyan-400" />
                  Manual Connect Fallback
                </h4>
                <button
                  onClick={() => setShowManualPeerInput(false)}
                  className="text-slate-500 hover:text-slate-300"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Direct Code Join */}
              <div className="space-y-2">
                <label className="text-[11px] font-semibold text-slate-400 block">
                  Join via 6-Character Room Code:
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    maxLength={6}
                    value={joinInput}
                    onChange={(e) => setJoinInput(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                    placeholder="E.G. A1B2C3"
                    className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 font-mono text-center text-sm font-bold tracking-widest text-cyan-300 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500 uppercase"
                  />
                  <button
                    onClick={() => handleDirectJoinRoom(joinInput)}
                    disabled={joinInput.length < 6}
                    className="btn-primary text-xs px-4 disabled:opacity-50"
                  >
                    Join
                  </button>
                </div>
              </div>

              {/* Paste JSON Form */}
              <form onSubmit={handleManualPeerValidate} className="space-y-2 pt-2 border-t border-slate-800/80">
                <label className="text-[11px] font-semibold text-slate-400 block">
                  Or Paste Raw Peer Public Identity JSON:
                </label>
                <textarea
                  rows={2}
                  value={rawPeerJsonInput}
                  onChange={(e) => setRawPeerJsonInput(e.target.value)}
                  placeholder='{"protocol":"covert-chatter","fingerprint":"...","ecdsa":{...},"ecdh":{...}}'
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl p-2.5 text-xs font-mono text-cyan-300 focus:outline-none focus:border-cyan-500 placeholder:text-slate-600"
                />
                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={!rawPeerJsonInput.trim()}
                    className="btn-secondary text-xs py-1.5 px-4 disabled:opacity-50"
                  >
                    Validate & Link JSON
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>
      ) : null}

      {/* ========================================================================= */}
      {/* 2. JOIN SCANNER MODAL (Immediate Camera Viewfinder for Guest)              */}
      {/* ========================================================================= */}
      {isJoinScannerOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/90 backdrop-blur-md flex items-center justify-center p-4 animate-fade-in">
          <div className="glass-panel p-6 sm:p-8 rounded-2xl max-w-md w-full space-y-6 border-cyan-500/40 animate-scale-up">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="p-2 bg-cyan-500/10 border border-cyan-500/30 rounded-xl text-cyan-400">
                  <Camera className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-white">Scan Friend's QR Code</h3>
                  <p className="text-[11px] text-slate-400">Point your camera at their Start Chat screen</p>
                </div>
              </div>

              <button
                onClick={stopCameraScanner}
                className="p-2 rounded-lg bg-slate-900 text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Viewfinder Frame */}
            <div className="relative rounded-2xl overflow-hidden bg-slate-950 border border-slate-800 min-h-[280px] flex items-center justify-center">
              <div id={scannerContainerId} className="w-full max-w-xs overflow-hidden rounded-xl" />

              {/* Animated Viewfinder Overlay */}
              <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                <div className="w-56 h-56 border-2 border-cyan-400/80 rounded-2xl relative animate-pulse shadow-[0_0_20px_rgba(6,182,212,0.3)]">
                  <div className="absolute top-0 left-0 w-4 h-4 border-t-4 border-l-4 border-cyan-400 -mt-1 -ml-1 rounded-tl" />
                  <div className="absolute top-0 right-0 w-4 h-4 border-t-4 border-r-4 border-cyan-400 -mt-1 -mr-1 rounded-tr" />
                  <div className="absolute bottom-0 left-0 w-4 h-4 border-b-4 border-l-4 border-cyan-400 -mb-1 -ml-1 rounded-bl" />
                  <div className="absolute bottom-0 right-0 w-4 h-4 border-b-4 border-r-4 border-cyan-400 -mb-1 -mr-1 rounded-br" />
                </div>
              </div>
            </div>

            {cameraError && (
              <div className="p-3 bg-rose-950/50 border border-rose-800/60 rounded-xl text-rose-300 text-xs flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 text-rose-400 mt-0.5" />
                <span>{cameraError}</span>
              </div>
            )}

            {/* Image File Upload Alternative */}
            <div className="flex items-center justify-between gap-3 pt-2 border-t border-slate-800">
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
                <FileImage className="w-4 h-4 text-emerald-400" />
                <span>{isProcessingFile ? 'Reading Image...' : 'Upload QR Image'}</span>
              </button>
              <button
                onClick={stopCameraScanner}
                className="btn-secondary text-xs py-2 px-4"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* 3. HOST WAITING STATE (Full-Screen High-Density Unified QR Code)          */}
      {/* ========================================================================= */}
      {status === 'waiting' && roomCode && (
        <div className="glass-panel p-8 sm:p-10 rounded-3xl text-center max-w-lg mx-auto space-y-6 animate-scale-up border-emerald-500/40 shadow-2xl shadow-emerald-950/40">
          <div className="space-y-1">
            <span className="badge-emerald text-xs">Room Created & Ready</span>
            <h3 className="text-2xl font-black text-white">Show this to your friend</h3>
            <p className="text-xs text-slate-400">
              Have your friend tap "Join Chat" and scan this QR code to connect.
            </p>
          </div>

          {/* High Density QR Code */}
          <div className="p-5 bg-white rounded-2xl shadow-2xl inline-block mx-auto transition-transform hover:scale-105">
            <QRCodeSVG
              value={hostQrPayload}
              size={220}
              level="M"
              includeMargin={false}
            />
          </div>

          {/* Room Code Display with 1-Click Copy */}
          <div className="space-y-2">
            <span className="text-[11px] text-slate-400 uppercase tracking-widest font-semibold">
              Or Share Room Code:
            </span>
            <div className="flex items-center justify-center gap-2">
              <span className="font-mono text-3xl font-black tracking-widest text-emerald-300 bg-slate-950 px-5 py-2 rounded-xl border border-slate-800 select-all shadow-inner">
                {roomCode}
              </span>
              <button
                onClick={handleCopyRoomCode}
                className="p-3 rounded-xl bg-slate-900 border border-slate-800 hover:bg-slate-800 text-slate-300 hover:text-white transition-all shadow-lg"
                title="Copy Room Code"
              >
                {copiedCode ? <Check className="w-5 h-5 text-emerald-400" /> : <Copy className="w-5 h-5" />}
              </button>
            </div>
          </div>

          <div className="flex items-center justify-center gap-2 text-xs text-slate-400 pt-2">
            <Loader2 className="w-4 h-4 animate-spin text-emerald-400" />
            <span>Awaiting peer connection...</span>
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
      {/* 4. CONNECTING / NEGOTIATING STATE                                         */}
      {/* ========================================================================= */}
      {(status === 'creating' || status === 'joining' || status === 'connecting') && status !== 'waiting' && (
        <div className="glass-panel p-8 sm:p-12 rounded-2xl text-center max-w-lg mx-auto space-y-6 animate-scale-up border-cyan-500/30">
          <div className="w-16 h-16 rounded-2xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400 mx-auto shadow-lg shadow-cyan-950/50">
            <RefreshCw className="w-8 h-8 animate-spin" />
          </div>

          <div className="space-y-2">
            <span className="badge-cyan text-xs">
              {status === 'creating' ? 'Creating Room...' : status === 'joining' ? 'Joining Room...' : 'Negotiating E2EE Session...'}
            </span>
            <h3 className="text-xl font-bold text-white">
              {verifiedPeer ? `Connecting to ${verifiedPeer.fingerprint.slice(0, 10)}...` : 'Establishing WebRTC Tunnel...'}
            </h3>
            <p className="text-xs text-slate-400 max-w-sm mx-auto">
              {statusDetails?.message || 'Exchanging cryptographic key identities and deriving non-extractable AES-256-GCM session key.'}
            </p>
          </div>

          {roomCode && (
            <div className="font-mono text-sm text-cyan-300 font-semibold bg-slate-900/60 py-2 px-4 rounded-xl border border-slate-800 inline-block">
              Room: {roomCode}
            </div>
          )}

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
      {/* 5. CONNECTED STATE (Active Ephemeral E2EE Chat Room)                       */}
      {/* ========================================================================= */}
      {status === 'connected' && (
        <div 
          onDragOver={handleDragOver}
          onDragEnter={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`glass-panel rounded-2xl overflow-hidden border-emerald-500/30 flex flex-col h-[650px] animate-scale-up shadow-2xl relative transition-all ${
            isDraggingOver ? 'ring-2 ring-cyan-400 bg-cyan-950/20' : ''
          }`}
        >
          {/* Hidden File Input Picker */}
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileInputChange}
            className="hidden"
          />

          {/* Drag & Drop Visual Overlay */}
          {isDraggingOver && (
            <div className="absolute inset-0 z-50 bg-slate-950/90 backdrop-blur-sm border-2 border-dashed border-cyan-400 rounded-2xl flex flex-col items-center justify-center p-6 space-y-4 animate-scale-up pointer-events-none">
              <div className="p-4 rounded-2xl bg-cyan-500/20 text-cyan-300 animate-bounce">
                <UploadCloud className="w-12 h-12" />
              </div>
              <div className="text-center space-y-1">
                <h3 className="text-lg font-bold text-white">Drop File to Encrypt & Send</h3>
                <p className="text-xs text-cyan-300">Files are chunked in 16KB blocks and encrypted with AES-256-GCM (Max 25MB)</p>
              </div>
            </div>
          )}

          {/* Chat Header with E2EE Badge and Peer Fingerprint */}
          <div className="p-4 bg-slate-900/90 border-b border-slate-800 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="w-3 h-3 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_10px_#10b981]" />
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-bold text-white">
                    {connectionType === 'relay' ? 'Relayed P2P Encrypted Session' : 'Direct P2P Encrypted Session'}
                  </span>
                  <span className="badge-emerald text-[10px] flex items-center gap-1">
                    <Lock className="w-3 h-3" />
                    <span>AES-256-GCM + ECDSA</span>
                  </span>

                  {/* Pass 6 Connection Quality Indicator Badge */}
                  {connectionType === 'relay' ? (
                    <span 
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/10 border border-amber-500/30 text-amber-300 shadow-sm animate-fade-in"
                      title="Relayed via TURN server across restrictive NATs. All data remains end-to-end encrypted with zero plaintext exposure."
                    >
                      <Server className="w-2.5 h-2.5 text-amber-400" />
                      <span>Relayed connection</span>
                    </span>
                  ) : connectionType === 'direct' ? (
                    <span 
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 shadow-sm animate-fade-in"
                      title="Direct peer-to-peer connection established via local host/STUN reflexive candidates."
                    >
                      <Zap className="w-2.5 h-2.5 text-emerald-400" />
                      <span>Direct connection</span>
                    </span>
                  ) : null}
                </div>
                <div className="text-[11px] text-slate-400 flex items-center gap-2 mt-0.5">
                  <span>Room: <strong className="font-mono text-emerald-300">{roomCode}</strong></span>
                  <span>•</span>
                  <span>
                    Peer: <strong className="font-mono text-cyan-300">{verifiedPeer?.fingerprint ? verifiedPeer.fingerprint.slice(0, 16) + '...' : 'Authenticated Peer'}</strong>
                  </span>
                </div>
              </div>
            </div>

            <button
              onClick={handleDisconnect}
              className="btn-danger text-xs py-1.5 px-3 flex items-center gap-1.5 shrink-0"
              title="Leave room and purge memory"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Purge & Leave Room</span>
            </button>
          </div>

          {/* Ephemeral Memory Notice Banner */}
          <div className="bg-slate-900/95 border-b border-slate-800/80 px-4 py-2 flex items-center justify-between gap-2 text-[11px] text-slate-400">
            <div className="flex items-center gap-2">
              <Info className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
              <span className="leading-snug">
                Volatile RAM only. Leaving room, tab close, or 30s background blur permanently wipes all messages & files.
              </span>
            </div>
            <span className="text-slate-500 font-mono text-[10px] hidden sm:inline">Max File: 25MB</span>
          </div>

          {/* Chat Message Stream */}
          <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4 bg-slate-950/40">
            {messages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-400 space-y-3">
                <div className="p-3 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-amber-400">
                  <Flame className="w-8 h-8" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-200">Ephemeral Channel Active</p>
                  <p className="text-xs max-w-sm text-slate-400 mt-1">
                    Send encrypted text messages or drop files (up to 25MB). Chunks stream directly peer-to-peer with zero server storage.
                  </p>
                </div>
              </div>
            ) : (
              messages.map((msg) => {
                const isMe = msg.sender === 'me';
                const remainingSecs = getRemainingSeconds(msg, currentTime);
                const isBurn = msg.burnOnRead;
                const isFile = msg.type === 'file';

                return (
                  <div
                    key={msg.id}
                    className={`flex flex-col ${isMe ? 'items-end' : 'items-start'} space-y-1 animate-fade-in transition-opacity duration-300 ${remainingSecs <= 2 ? 'opacity-40 animate-pulse' : 'opacity-100'}`}
                  >
                    {/* Message Header Badges */}
                    <div className="flex items-center gap-1.5 text-[10px] text-slate-400 px-1">
                      <span className="font-semibold text-slate-300">{isMe ? 'You' : 'Peer'}</span>
                      <span>•</span>
                      {isBurn ? (
                        <span className="text-amber-400 font-semibold flex items-center gap-0.5 bg-amber-950/60 border border-amber-500/30 px-1.5 py-0.5 rounded-full">
                          <Flame className="w-2.5 h-2.5 text-amber-400 animate-pulse" />
                          <span>Burn in {remainingSecs}s</span>
                        </span>
                      ) : (
                        <span className="text-cyan-400 font-mono flex items-center gap-0.5 bg-slate-900 border border-slate-800 px-1.5 py-0.5 rounded-full">
                          <Clock className="w-2.5 h-2.5 text-cyan-400" />
                          <span>{remainingSecs}s</span>
                        </span>
                      )}
                      {msg.isEncrypted && (
                        <span className="text-emerald-400 font-mono text-[9px] flex items-center gap-0.5 ml-1">
                          <Lock className="w-2.5 h-2.5 inline" /> E2EE
                        </span>
                      )}
                    </div>

                    {/* Content Rendering: File Card vs Text Bubble */}
                    {isFile ? (
                      /* Pass 5: Encrypted Ephemeral File Card */
                      <div
                        className={`w-full max-w-sm p-4 rounded-2xl border transition-all ${
                          isMe
                            ? 'bg-slate-900/90 border-emerald-500/40 rounded-br-none shadow-lg shadow-emerald-950/20'
                            : isBurn
                            ? 'bg-slate-900/90 border-amber-500/40 rounded-bl-none shadow-lg shadow-amber-950/20'
                            : 'bg-slate-900/90 border-slate-700/80 rounded-bl-none shadow-lg'
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <div className={`p-2.5 rounded-xl border shrink-0 ${
                            msg.status === 'completed'
                              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                              : 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400 animate-pulse'
                          }`}>
                            {msg.status === 'completed' ? (
                              <FileText className="w-6 h-6" />
                            ) : (
                              <Loader2 className="w-6 h-6 animate-spin" />
                            )}
                          </div>

                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2">
                              <h4 className="text-xs font-bold text-white truncate" title={msg.fileName}>
                                {msg.fileName}
                              </h4>
                              <span className="text-[10px] font-mono text-slate-400 shrink-0">
                                {formatFileSize(msg.fileSize)}
                              </span>
                            </div>

                            {/* Progress or Actions */}
                            {msg.status === 'transferring' ? (
                              <div className="mt-2 space-y-1">
                                <div className="flex justify-between text-[10px] text-cyan-300">
                                  <span>{isMe ? 'Streaming chunks...' : 'Receiving & verifying...'}</span>
                                  <span>{msg.progress || 0}%</span>
                                </div>
                                <div className="w-full h-1.5 bg-slate-950 rounded-full overflow-hidden border border-slate-800">
                                  <div
                                    className="h-full bg-gradient-to-r from-cyan-500 to-emerald-400 transition-all duration-150"
                                    style={{ width: `${msg.progress || 0}%` }}
                                  />
                                </div>
                              </div>
                            ) : msg.status === 'completed' && msg.blobUrl ? (
                              <div className="mt-3 flex items-center justify-between gap-2">
                                <span className="text-[10px] text-emerald-400 font-semibold flex items-center gap-1">
                                  <CheckCircle2 className="w-3 h-3" />
                                  <span>Decrypted in RAM</span>
                                </span>
                                <a
                                  href={msg.blobUrl}
                                  download={msg.fileName}
                                  className="btn-primary text-xs py-1 px-3 inline-flex items-center gap-1.5"
                                >
                                  <Download className="w-3.5 h-3.5" />
                                  <span>Download</span>
                                </a>
                              </div>
                            ) : (
                              <p className="text-[10px] text-rose-400 mt-1">Transfer error or interrupted.</p>
                            )}
                          </div>
                        </div>
                      </div>
                    ) : (
                      /* Text Message Bubble */
                      <div
                        className={`p-3.5 rounded-2xl text-xs max-w-sm sm:max-w-md break-words shadow-md transition-all ${
                          isMe
                            ? 'bg-gradient-to-br from-emerald-500 to-emerald-600 text-white rounded-br-none shadow-emerald-950/30'
                            : isBurn
                            ? 'bg-slate-900 text-slate-100 border border-amber-500/40 rounded-bl-none shadow-amber-950/20'
                            : 'bg-slate-900 text-slate-100 border border-slate-800 rounded-bl-none'
                        }`}
                      >
                        {msg.text}
                      </div>
                    )}
                  </div>
                );
              })
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Staged File Attachment Preview Bar */}
          {attachedFile && (
            <div className="p-3 bg-slate-900 border-t border-slate-800 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 animate-slide-up">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 shrink-0">
                  <File className="w-4 h-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-bold text-white truncate max-w-xs">{attachedFile.name}</p>
                  <p className="text-[10px] text-slate-400">{formatFileSize(attachedFile.size)} • 16KB encrypted chunks</p>
                </div>
              </div>

              {/* TTL and Burn on Read Options for File */}
              <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
                <select
                  value={fileTtlSeconds}
                  onChange={(e) => setFileTtlSeconds(Number(e.target.value))}
                  className="bg-slate-950 border border-slate-800 rounded-lg px-2 py-1 text-[11px] text-cyan-300 focus:outline-none"
                >
                  {FILE_TTL_OPTIONS.map((opt) => (
                    <option key={opt.seconds} value={opt.seconds}>
                      {opt.label}
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  onClick={() => setFileBurnOnRead(!fileBurnOnRead)}
                  className={`text-xs py-1 px-2.5 rounded-lg border flex items-center gap-1 transition-all ${
                    fileBurnOnRead
                      ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                      : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-300'
                  }`}
                  title="Burn on Read: file self-destructs 5s after recipient downloads"
                >
                  <Flame className={`w-3.5 h-3.5 ${fileBurnOnRead ? 'text-amber-400 animate-pulse' : 'text-slate-500'}`} />
                  <span className="text-[11px]">Burn</span>
                </button>

                <button
                  onClick={() => setAttachedFile(null)}
                  className="p-1 rounded-lg text-slate-400 hover:text-rose-400"
                >
                  <X className="w-4 h-4" />
                </button>

                <button
                  onClick={handleSendAttachedFile}
                  disabled={isSendingFile}
                  className="btn-primary text-xs py-1 px-3 flex items-center gap-1.5"
                >
                  {isSendingFile ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Sending...</span>
                    </>
                  ) : (
                    <>
                      <Send className="w-3.5 h-3.5" />
                      <span>Send File</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Chat Message Input Bar */}
          <form onSubmit={handleSendMessage} className="p-3 bg-slate-900 border-t border-slate-800 flex items-center gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="p-2.5 rounded-xl bg-slate-950 border border-slate-800 text-slate-400 hover:text-cyan-400 hover:border-cyan-500/40 transition-all shrink-0"
              title="Attach File (Up to 25MB)"
            >
              <Paperclip className="w-4 h-4" />
            </button>

            <button
              type="button"
              onClick={() => setBurnOnReadEnabled(!burnOnReadEnabled)}
              className={`p-2.5 rounded-xl border flex items-center gap-1.5 text-xs transition-all shrink-0 ${
                burnOnReadEnabled
                  ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                  : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-300'
              }`}
              title="Burn on Read: message self-destructs 5s after peer views it"
            >
              <Flame className={`w-4 h-4 ${burnOnReadEnabled ? 'text-amber-400 animate-pulse' : 'text-slate-500'}`} />
              <span className="hidden sm:inline">Burn (5s)</span>
            </button>

            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder="Send an end-to-end encrypted ephemeral message..."
              className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500"
            />

            <button
              type="submit"
              disabled={!inputText.trim()}
              className="btn-primary text-xs py-2.5 px-4 flex items-center gap-1.5 shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Send className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Send</span>
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
