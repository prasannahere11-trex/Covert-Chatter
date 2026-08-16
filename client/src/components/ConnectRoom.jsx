import React, { useState, useEffect, useRef } from 'react';
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
  Loader2
} from 'lucide-react';
import { PeerSession } from '../utils/webrtc';
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

export default function ConnectRoom({ 
  myIdentity, 
  verifiedPeer, 
  onSetVerifiedPeer, 
  onNavigateToScan, 
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
  const [customServerUrl, setCustomServerUrl] = useState('ws://localhost:8080');
  const [showServerConfig, setShowServerConfig] = useState(false);
  const [rawPeerJsonInput, setRawPeerJsonInput] = useState('');
  const [showManualPeerInput, setShowManualPeerInput] = useState(false);
  const [currentTime, setCurrentTime] = useState(Date.now());

  // Pass 5 File Sharing States
  const [attachedFile, setAttachedFile] = useState(null);
  const [fileTtlSeconds, setFileTtlSeconds] = useState(DEFAULT_FILE_TTL_SECONDS); // 180s (3m) default
  const [fileBurnOnRead, setFileBurnOnRead] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [isSendingFile, setIsSendingFile] = useState(false);

  const sessionRef = useRef(null);
  const messagesEndRef = useRef(null);
  const blurTimerRef = useRef(null);
  const fileInputRef = useRef(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Auto-scroll chat to bottom
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

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
          // For completed files or regular text messages
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
        // Start 30s background blur timer
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
      // Immediate volatile wipe on tab close
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
      messagesRef.current.forEach(revokeFileBlobUrl);
    };
  }, []);

  const handleManualPeerValidate = async (e) => {
    e?.preventDefault();
    if (!rawPeerJsonInput.trim()) return;

    try {
      const res = await validatePeerIdentityPayload(rawPeerJsonInput.trim());
      if (res.valid && res.peerIdentity) {
        onSetVerifiedPeer(res.peerIdentity);
        setShowManualPeerInput(false);
        setRawPeerJsonInput('');
        onShowToast('Peer identity verified and linked!', 'success');
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

  const initSession = () => {
    if (!verifiedPeer) {
      onShowToast('Please scan or paste peer identity before connecting', 'warning');
      return null;
    }

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
            setMessages([]); // Instant volatile memory purge on disconnect
            setAttachedFile(null);
            onShowToast(details?.message || 'Peer disconnected — memory purged', 'warning');
          } else if (newStatus === 'error') {
            messagesRef.current.forEach(revokeFileBlobUrl);
            setMessages([]);
            setAttachedFile(null);
            onShowToast(details?.message || 'Connection error', 'error');
          }
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
      verifiedPeer,
      customServerUrl
    );

    sessionRef.current = session;
    return session;
  };

  const handleCreateRoom = async () => {
    messagesRef.current.forEach(revokeFileBlobUrl);
    setMessages([]);
    setRoomCode('');
    const session = initSession();
    if (session) {
      await session.createRoom();
    }
  };

  const handleJoinRoom = async (e) => {
    e?.preventDefault();
    const cleanCode = joinInput.trim().toUpperCase();
    if (!cleanCode || cleanCode.length < 6) {
      onShowToast('Please enter a valid 6-character room code', 'warning');
      return;
    }

    messagesRef.current.forEach(revokeFileBlobUrl);
    setMessages([]);
    const session = initSession();
    if (session) {
      await session.joinRoom(cleanCode);
    }
  };

  const handleCopyRoomCode = async () => {
    if (!roomCode) return;
    try {
      await navigator.clipboard.writeText(roomCode);
      setCopiedCode(true);
      onShowToast(`Room code ${roomCode} copied to clipboard`, 'success');
      setTimeout(() => setCopiedCode(false), 2000);
    } catch {
      onShowToast('Failed to copy room code', 'error');
    }
  };

  const handleSendMessage = async (e) => {
    e?.preventDefault();
    const trimmed = inputText.trim();
    if (!trimmed || !sessionRef.current) return;

    try {
      const msgRecord = await sessionRef.current.sendMessage(trimmed, {
        ttlSeconds: DEFAULT_TTL_SECONDS,
        burnOnRead: burnOnReadEnabled,
      });

      setMessages((prev) => [...prev, msgRecord]);
      setInputText('');
    } catch (err) {
      onShowToast(err.message || 'Failed to send message', 'error');
    }
  };

  const handleSelectFile = (file) => {
    if (!file) return;
    if (file.size > MAX_FILE_SIZE) {
      onShowToast(`File size (${formatFileSize(file.size)}) exceeds the 25MB limit.`, 'error');
      return;
    }
    setAttachedFile(file);
    setFileTtlSeconds(DEFAULT_FILE_TTL_SECONDS); // 3 minutes default
  };

  const handleFileInputChange = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      handleSelectFile(file);
    }
    // Reset file input so same file can be selected again if cancelled
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleSendAttachedFile = async () => {
    if (!attachedFile || !sessionRef.current || isSendingFile) return;

    const file = attachedFile;
    setIsSendingFile(true);

    try {
      await sessionRef.current.sendFile(
        file,
        {
          ttlSeconds: fileTtlSeconds,
          burnOnRead: fileBurnOnRead,
        },
        (progressData) => {
          handleIncomingMessageOrFile(progressData);
        }
      );

      setAttachedFile(null);
      setFileBurnOnRead(false);
      onShowToast(`Encrypted file "${file.name}" sent successfully!`, 'success');
    } catch (err) {
      console.error('[FileTransfer] Send error:', err);
      onShowToast(err.message || 'Failed to send file', 'error');
    } finally {
      setIsSendingFile(false);
    }
  };

  // Drag-and-Drop Handlers
  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (status === 'connected' && !isDraggingOver) {
      setIsDraggingOver(true);
    }
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
    setMessages([]); // Instant volatile memory purge
    setAttachedFile(null);
    onShowToast('Disconnected from room — all messages wiped', 'info');
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Top Header Card */}
      <div className="glass-panel p-6 sm:p-8 rounded-2xl relative overflow-hidden">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
                <Flame className="w-5 h-5 text-amber-400 animate-pulse" />
                Ephemeral End-to-End Encrypted Tunnel
              </h2>
              <span className="badge-emerald text-[11px]">Pass 5: E2EE File Drops Active</span>
            </div>
            <p className="text-xs text-slate-400">
              Zero disk persistence. Text & files are chunked (16KB), encrypted with AES-256-GCM, signed via ECDSA, and automatically wiped from RAM upon expiry.
            </p>
          </div>

          <button
            onClick={() => setShowServerConfig(!showServerConfig)}
            className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5"
            title="Configure Signaling Server URL"
          >
            <Server className="w-3.5 h-3.5 text-cyan-400" />
            <span>Signaling URL</span>
            {showServerConfig ? (
              <ChevronUp className="w-3.5 h-3.5" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5" />
            )}
          </button>
        </div>

        {/* Server URL Config Bar */}
        {showServerConfig && (
          <div className="mt-4 p-3.5 bg-slate-900/90 border border-slate-800 rounded-xl space-y-2 animate-slide-up text-xs">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-slate-300">Signaling Server URL</span>
              <span className="text-[11px] text-emerald-400">Default: ws://localhost:8080</span>
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={customServerUrl}
                onChange={(e) => setCustomServerUrl(e.target.value)}
                disabled={status !== 'idle' && status !== 'disconnected' && status !== 'error'}
                placeholder="ws://localhost:8080"
                className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 font-mono text-emerald-300 focus:outline-none focus:border-emerald-500"
              />
              <button
                onClick={() => setCustomServerUrl('ws://localhost:8080')}
                className="btn-secondary text-xs px-3 py-1.5"
              >
                Reset
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Step 1: Peer Identity Binding Card */}
      <div className={`glass-panel p-6 rounded-2xl border transition-all ${verifiedPeer ? 'border-emerald-500/40 bg-slate-900/40' : 'border-amber-500/40 bg-amber-950/10'}`}>
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className={`p-3 rounded-xl border ${verifiedPeer ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' : 'bg-amber-500/10 border-amber-500/30 text-amber-400'}`}>
              {verifiedPeer ? <ShieldCheck className="w-6 h-6" /> : <KeyRound className="w-6 h-6" />}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-bold text-white">
                  {verifiedPeer ? 'Authenticated Peer Identity Linked' : 'Peer Identity Required for E2EE'}
                </h3>
                {verifiedPeer && <span className="badge-emerald text-[10px]">E2EE Ready</span>}
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                {verifiedPeer ? (
                  <span>
                    Verified Fingerprint: <strong className="font-mono text-emerald-300">{verifiedPeer.fingerprint}</strong>
                  </span>
                ) : (
                  'Scan your peer’s QR code or paste their public identity payload to derive the shared AES-GCM session key.'
                )}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 w-full md:w-auto">
            {!verifiedPeer ? (
              <>
                <button
                  onClick={onNavigateToScan}
                  className="btn-primary text-xs py-2 px-3 flex items-center justify-center gap-1.5 flex-1 md:flex-initial"
                >
                  <QrCode className="w-3.5 h-3.5" />
                  <span>Scan via Camera / Image</span>
                </button>
                <button
                  onClick={() => setShowManualPeerInput(!showManualPeerInput)}
                  className="btn-secondary text-xs py-2 px-3 flex items-center justify-center gap-1.5"
                >
                  <FileCode className="w-3.5 h-3.5 text-cyan-400" />
                  <span>Paste JSON</span>
                </button>
              </>
            ) : (
              <button
                onClick={() => onSetVerifiedPeer(null)}
                disabled={status === 'connected' || status === 'connecting'}
                className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5 disabled:opacity-50"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Switch Peer</span>
              </button>
            )}
          </div>
        </div>

        {/* Manual Peer Payload Input Form */}
        {showManualPeerInput && !verifiedPeer && (
          <form onSubmit={handleManualPeerValidate} className="mt-4 pt-4 border-t border-slate-800 space-y-3 animate-slide-up">
            <label className="text-xs font-semibold text-slate-300 block">
              Paste Peer Public Identity Payload (JSON / QR Data):
            </label>
            <textarea
              rows={3}
              value={rawPeerJsonInput}
              onChange={(e) => setRawPeerJsonInput(e.target.value)}
              placeholder='{"protocol":"whisper-drop","fingerprint":"...","ecdsa":{...},"ecdh":{...}}'
              className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs font-mono text-cyan-300 focus:outline-none focus:border-cyan-500 placeholder:text-slate-600"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowManualPeerInput(false)}
                className="btn-secondary text-xs py-1.5 px-3"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!rawPeerJsonInput.trim()}
                className="btn-primary text-xs py-1.5 px-4 disabled:opacity-50"
              >
                Validate & Link Identity
              </button>
            </div>
          </form>
        )}
      </div>

      {/* Main Connection State Container */}
      {status === 'idle' ? (
        /* Setup / Lobby View */
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Card A: Create Room */}
          <div className={`glass-panel p-6 sm:p-8 rounded-2xl flex flex-col justify-between space-y-6 transition-all ${verifiedPeer ? 'border-emerald-500/20 hover:border-emerald-500/40' : 'opacity-60'}`}>
            <div className="space-y-3">
              <div className="w-12 h-12 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shadow-lg shadow-emerald-950/40">
                <Zap className="w-6 h-6" />
              </div>
              <h3 className="text-lg font-bold text-white">Create Ephemeral Room</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Act as the host. Creates a 6-character room code and waits for your verified peer to establish the E2EE channel.
              </p>
            </div>

            <button
              onClick={handleCreateRoom}
              disabled={!verifiedPeer}
              className="btn-primary w-full py-3 text-sm flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Sparkles className="w-4 h-4" />
              <span>Create E2EE Ephemeral Room</span>
            </button>
          </div>

          {/* Card B: Join Existing Room */}
          <div className={`glass-panel p-6 sm:p-8 rounded-2xl flex flex-col justify-between space-y-6 transition-all ${verifiedPeer ? 'border-cyan-500/20 hover:border-cyan-500/40' : 'opacity-60'}`}>
            <div className="space-y-3">
              <div className="w-12 h-12 rounded-xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400 shadow-lg shadow-cyan-950/40">
                <Users className="w-6 h-6" />
              </div>
              <h3 className="text-lg font-bold text-white">Join Ephemeral Room</h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Enter the 6-character room code given by the host to connect and derive the AES-GCM session key.
              </p>
            </div>

            <form onSubmit={handleJoinRoom} className="space-y-3">
              <div>
                <input
                  type="text"
                  maxLength={6}
                  value={joinInput}
                  disabled={!verifiedPeer}
                  onChange={(e) => setJoinInput(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                  placeholder="E.G. A1B2C3"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 font-mono text-center text-lg font-bold tracking-widest text-cyan-300 placeholder:text-slate-600 focus:outline-none focus:border-cyan-500 uppercase disabled:opacity-50"
                />
              </div>
              <button
                type="submit"
                disabled={!verifiedPeer || joinInput.length < 6}
                className="btn-secondary w-full py-2.5 text-sm flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Users className="w-4 h-4 text-cyan-400" />
                <span>Join Room</span>
              </button>
            </form>
          </div>
        </div>
      ) : status === 'waiting' ? (
        /* Waiting for Peer State (Host) */
        <div className="glass-panel p-8 sm:p-12 rounded-2xl text-center max-w-lg mx-auto space-y-6 animate-scale-up border-emerald-500/30">
          <div className="w-16 h-16 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 mx-auto shadow-lg shadow-emerald-950/50">
            <Radio className="w-8 h-8 animate-pulse" />
          </div>

          <div className="space-y-2">
            <span className="badge-emerald text-xs">Room Created & Ready</span>
            <h3 className="text-2xl font-black text-white">Waiting for Peer to Join</h3>
            <p className="text-xs text-slate-400 max-w-sm mx-auto">
              Share this 6-character code with your verified peer. WebRTC negotiation and AES-GCM session key derivation will execute automatically.
            </p>
          </div>

          {/* Prominent Room Code Display */}
          <div className="bg-slate-900/90 border border-emerald-500/40 rounded-2xl p-4 sm:p-6 relative group max-w-xs mx-auto shadow-inner">
            <div className="text-xs uppercase font-semibold text-slate-400 mb-1">Room Code</div>
            <div className="font-mono text-3xl sm:text-4xl font-extrabold text-emerald-400 tracking-widest select-all">
              {roomCode}
            </div>
            <button
              onClick={handleCopyRoomCode}
              className="mt-3 btn-primary text-xs py-1.5 px-4 inline-flex items-center gap-1.5"
            >
              {copiedCode ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copiedCode ? 'Copied Code!' : 'Copy Code'}</span>
            </button>
          </div>

          <div className="flex items-center justify-center gap-3 pt-2">
            <button
              onClick={handleDisconnect}
              className="btn-danger text-xs py-2 px-4 flex items-center gap-1.5"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span>Cancel & Close Room</span>
            </button>
          </div>
        </div>
      ) : status === 'creating' || status === 'joining' || status === 'connecting' ? (
        /* Connecting / Negotiating State */
        <div className="glass-panel p-8 sm:p-12 rounded-2xl text-center max-w-lg mx-auto space-y-6 animate-scale-up border-cyan-500/30">
          <div className="w-16 h-16 rounded-2xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center text-cyan-400 mx-auto shadow-lg shadow-cyan-950/50">
            <RefreshCw className="w-8 h-8 animate-spin" />
          </div>

          <div className="space-y-2">
            <span className="badge-cyan text-xs">
              {status === 'creating' ? 'Creating Room...' : status === 'joining' ? 'Joining Room...' : 'Negotiating WebRTC & Deriving Keys...'}
            </span>
            <h3 className="text-xl font-bold text-white">
              {status === 'connecting' ? 'Connecting & Deriving AES-GCM Key...' : 'Contacting Signaling Server...'}
            </h3>
            <p className="text-xs text-slate-400 max-w-sm mx-auto">
              {statusDetails?.message || 'Exchanging SDP session descriptions, ICE candidates, and performing ECDH shared secret key agreement.'}
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
      ) : status === 'connected' ? (
        /* Connected State: Live Ephemeral E2EE Chat Box with File Dropzone */
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
                <div className="flex items-center gap-2">
                  <span className="text-sm font-bold text-white">Direct P2P Encrypted Session</span>
                  <span className="badge-emerald text-[10px] flex items-center gap-1">
                    <Lock className="w-3 h-3" />
                    <span>AES-256-GCM + ECDSA</span>
                  </span>
                </div>
                <div className="text-[11px] text-slate-400 flex items-center gap-2 mt-0.5">
                  <span>Room: <strong className="font-mono text-emerald-300">{roomCode}</strong></span>
                  <span>•</span>
                  <span>
                    Peer: <strong className="font-mono text-cyan-300">{verifiedPeer?.fingerprint || 'Verified'}</strong>
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
                            <h4 className="text-xs font-bold text-white truncate" title={msg.fileName}>
                              {msg.fileName}
                            </h4>
                            <div className="flex items-center gap-2 text-[11px] text-slate-400 mt-0.5">
                              <span>{formatFileSize(msg.fileSize)}</span>
                              <span>•</span>
                              <span className="font-mono text-cyan-300">
                                {msg.status === 'completed' ? 'E2EE Verified' : `${msg.progress || 0}%`}
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* Streaming Progress Bar */}
                        {msg.status !== 'completed' ? (
                          <div className="mt-3 space-y-1.5">
                            <div className="w-full bg-slate-950 rounded-full h-2 overflow-hidden border border-slate-800">
                              <div
                                className="bg-gradient-to-r from-cyan-500 to-emerald-400 h-full transition-all duration-200 rounded-full"
                                style={{ width: `${Math.max(5, msg.progress || 0)}%` }}
                              />
                            </div>
                            <div className="flex justify-between items-center text-[10px] text-slate-400">
                              <span>{isMe ? 'Encrypting & Streaming...' : 'Receiving & Decrypting...'}</span>
                              <span className="font-mono font-bold text-emerald-400">{msg.progress || 0}%</span>
                            </div>
                          </div>
                        ) : (
                          /* Completed Download Action */
                          <div className="mt-3 pt-3 border-t border-slate-800/80 flex items-center justify-between gap-2">
                            {msg.blobUrl ? (
                              <a
                                href={msg.blobUrl}
                                download={msg.fileName}
                                className="btn-primary text-xs py-1.5 px-3 flex items-center gap-1.5 w-full justify-center"
                              >
                                <Download className="w-3.5 h-3.5" />
                                <span>Download File ({formatFileSize(msg.fileSize)})</span>
                              </a>
                            ) : (
                              <span className="text-[11px] text-amber-400 italic">File buffer wiped</span>
                            )}
                          </div>
                        )}
                      </div>
                    ) : (
                      /* Standard Text Message Bubble */
                      <div
                        className={`max-w-md px-4 py-2.5 rounded-2xl text-sm leading-relaxed relative group ${
                          isMe
                            ? 'bg-gradient-to-r from-emerald-600 to-emerald-500 text-white rounded-br-none shadow-md shadow-emerald-950/50'
                            : isBurn
                            ? 'bg-slate-900 text-slate-100 border border-amber-500/40 rounded-bl-none shadow-lg shadow-amber-950/20'
                            : 'bg-slate-800/90 text-slate-100 border border-slate-700/80 rounded-bl-none shadow'
                        }`}
                      >
                        <p className="whitespace-pre-wrap break-words">{msg.text}</p>
                      </div>
                    )}
                  </div>
                );
              })
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Pass 5: Attached File Staging Modal / Bar */}
          {attachedFile && (
            <div className="bg-slate-900 border-t border-cyan-500/30 p-3.5 space-y-3 animate-slide-up">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="p-2 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-400">
                    <File className="w-4 h-4" />
                  </div>
                  <div className="truncate">
                    <div className="text-xs font-bold text-white truncate">{attachedFile.name}</div>
                    <div className="text-[11px] text-slate-400 font-mono">{formatFileSize(attachedFile.size)}</div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setAttachedFile(null)}
                  disabled={isSendingFile}
                  className="p-1 rounded-lg text-slate-400 hover:text-rose-400 transition-colors"
                  title="Remove attached file"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Expiry Selector Bar & Burn on Read for Files */}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs">
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-semibold text-slate-400">File Lifespan:</span>
                  <div className="flex rounded-lg bg-slate-950 p-0.5 border border-slate-800">
                    {FILE_TTL_OPTIONS.map((opt) => (
                      <button
                        key={opt.seconds}
                        type="button"
                        onClick={() => setFileTtlSeconds(opt.seconds)}
                        className={`px-2 py-0.5 rounded-md text-[11px] font-semibold transition-all ${
                          fileTtlSeconds === opt.seconds
                            ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow'
                            : 'text-slate-400 hover:text-slate-200'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setFileBurnOnRead(!fileBurnOnRead)}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-semibold transition-all ${
                    fileBurnOnRead
                      ? 'bg-amber-500/20 border-amber-500/50 text-amber-300'
                      : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200'
                  }`}
                  title="Self-destruct 5 seconds after recipient renders/downloads"
                >
                  <Flame className={`w-3 h-3 ${fileBurnOnRead ? 'text-amber-400 animate-pulse' : 'text-slate-500'}`} />
                  <span>Burn on Read (5s)</span>
                </button>
              </div>

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setAttachedFile(null)}
                  disabled={isSendingFile}
                  className="btn-secondary text-xs py-1.5 px-3"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSendAttachedFile}
                  disabled={isSendingFile}
                  className="btn-primary text-xs py-1.5 px-4 flex items-center gap-1.5 disabled:opacity-50"
                >
                  {isSendingFile ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Streaming Chunks...</span>
                    </>
                  ) : (
                    <>
                      <UploadCloud className="w-3.5 h-3.5" />
                      <span>Send Encrypted File</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Chat Controls & Input Bar */}
          <div className="bg-slate-900/90 border-t border-slate-800 p-3 space-y-2">
            {/* Ephemeral Toggles Bar for Text */}
            <div className="flex items-center justify-between px-1 text-xs">
              <button
                type="button"
                onClick={() => setBurnOnReadEnabled(!burnOnReadEnabled)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-semibold transition-all ${
                  burnOnReadEnabled
                    ? 'bg-amber-500/20 border-amber-500/50 text-amber-300 shadow-sm shadow-amber-950/50'
                    : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:text-slate-200'
                }`}
                title="Burn text message 5 seconds after recipient renders it"
              >
                <Flame className={`w-3.5 h-3.5 ${burnOnReadEnabled ? 'text-amber-400 animate-pulse' : 'text-slate-500'}`} />
                <span>Burn on read (5s)</span>
                {burnOnReadEnabled && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block ml-0.5" />}
              </button>

              <div className="text-[11px] text-slate-400 font-mono flex items-center gap-2">
                <span className="flex items-center gap-1">
                  <Clock className="w-3 h-3 text-cyan-400" />
                  <span>Text TTL: 60s</span>
                </span>
                <span>•</span>
                <span className="text-emerald-400">16KB Chunking E2EE</span>
              </div>
            </div>

            {/* Message Input Field with File Attachment Button */}
            <form onSubmit={handleSendMessage} className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="p-2.5 rounded-xl bg-slate-950 border border-slate-800 text-slate-400 hover:text-cyan-400 hover:border-cyan-500/50 transition-colors"
                title="Attach encrypted file (Max 25MB)"
              >
                <Paperclip className="w-4 h-4" />
              </button>

              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder={
                  burnOnReadEnabled 
                    ? "Type a burn-on-read message (5s timer)..." 
                    : "Type an encrypted ephemeral message..."
                }
                className="flex-1 bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-emerald-500 transition-colors"
              />

              <button
                type="submit"
                disabled={!inputText.trim()}
                className="btn-primary px-4 py-2.5 flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {burnOnReadEnabled ? <Flame className="w-4 h-4 text-amber-200" /> : <Send className="w-4 h-4" />}
                <span>Send</span>
              </button>
            </form>
          </div>
        </div>
      ) : (
        /* Disconnected / Error State */
        <div className="glass-panel p-8 sm:p-12 rounded-2xl text-center max-w-lg mx-auto space-y-6 animate-scale-up border-rose-500/30 shadow-2xl">
          <div className="w-16 h-16 rounded-2xl bg-rose-500/10 border border-rose-500/30 flex items-center justify-center text-rose-400 mx-auto">
            <AlertCircle className="w-8 h-8" />
          </div>

          <div className="space-y-2">
            <span className="badge-cyan text-xs">
              {status === 'disconnected' ? 'Session Terminated' : 'Connection Failed'}
            </span>
            <h3 className="text-xl font-bold text-white">
              {status === 'disconnected' ? 'Peer Disconnected & Memory Purged' : 'Unable to Connect'}
            </h3>
            <p className="text-sm text-slate-300 leading-relaxed max-w-sm mx-auto">
              {statusDetails?.message ||
                'The session was closed. All ephemeral message history, streaming files, room codes, and AES session keys have been permanently wiped from volatile RAM.'}
            </p>
          </div>

          <div className="pt-2">
            <button
              onClick={handleDisconnect}
              className="btn-primary text-xs py-2.5 px-6 inline-flex items-center gap-2"
            >
              <RefreshCw className="w-4 h-4" />
              <span>Return to Room Lobby</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
