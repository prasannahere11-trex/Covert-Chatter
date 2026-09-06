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
  Heart,
  AlertTriangle
} from 'lucide-react';
import { PeerSession, getDefaultSignalingUrl } from '../utils/webrtc';
import { validatePeerIdentityPayload } from '../utils/crypto';
import { 
  DEFAULT_TTL_SECONDS, 
  DEFAULT_FILE_TTL_SECONDS,
  TTL_OPTIONS,
  FILE_TTL_OPTIONS,
  BURN_ON_READ_DELAY_SECONDS, 
  BACKGROUND_BLUR_PURGE_TIMEOUT_MS,
  getRemainingSeconds, 
  formatRemainingTime,
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
  const [roomTtlSeconds, setRoomTtlSeconds] = useState(DEFAULT_TTL_SECONDS); // Synchronized Room Disappearing Timer
  const [showTtlDropdown, setShowTtlDropdown] = useState(false);
  const [burnOnReadEnabled, setBurnOnReadEnabled] = useState(false);
  const [customServerUrl, setCustomServerUrl] = useState(getDefaultSignalingUrl());
  const [showServerConfig, setShowServerConfig] = useState(false);
  const [rawPeerJsonInput, setRawPeerJsonInput] = useState('');
  const [showManualPeerInput, setShowManualPeerInput] = useState(false);
  const [currentTime, setCurrentTime] = useState(Date.now());
  const [showSecurityModal, setShowSecurityModal] = useState(false);
  const [showOptionsMenu, setShowOptionsMenu] = useState(false);

  // Mandatory Peer Verification Gate State (Task 3)
  const [isUnverifiedRiskAcknowledged, setIsUnverifiedRiskAcknowledged] = useState(false);

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
          const deadline = Date.now() + (msg.burnDelay || BURN_ON_READ_DELAY_SECONDS) * 1000;
          if (sessionRef.current) {
            sessionRef.current.sendBurnTrigger(msgId, msg.burnDelay || BURN_ON_READ_DELAY_SECONDS);
          }
          return {
            ...msg,
            renderedAt: Date.now(),
            burnDeadline: deadline,
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
            const deadline = now + (msg.burnDelay || BURN_ON_READ_DELAY_SECONDS) * 1000;
            if (sessionRef.current) {
              sessionRef.current.sendBurnTrigger(msg.id, msg.burnDelay || BURN_ON_READ_DELAY_SECONDS);
            }
            return {
              ...msg,
              renderedAt: now,
              burnDeadline: deadline,
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
    const isPeerFullyVerified = Boolean(verifiedPeer?.isExplicitlyVerified);
    const isChatUnlocked = isPeerFullyVerified || isUnverifiedRiskAcknowledged;
    if (!isChatUnlocked) {
      onShowToast('Please verify peer identity or acknowledge risk to send files', 'warning');
      return;
    }
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

      const peer = { ...validation.peerIdentity, isExplicitlyVerified: true };
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
        const peer = { ...res.peerIdentity, isExplicitlyVerified: true };
        onSetVerifiedPeer(peer);
        saveSessionPeer(peer);
        setShowManualPeerInput(false);
        setRawPeerJsonInput('');
        onShowToast('Peer identity verified!', 'success');
        if (res.peerIdentity.room) {
          await handleDirectJoinRoom(res.peerIdentity.room, peer);
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
            setIsUnverifiedRiskAcknowledged(false);
            onShowToast(details?.message || 'Peer disconnected', 'warning');
          } else if (newStatus === 'error') {
            messagesRef.current.forEach(revokeFileBlobUrl);
            setMessages([]);
            setAttachedFile(null);
            setIsUnverifiedRiskAcknowledged(false);
            onShowToast(details?.message || 'Connection error', 'error');
          }
        },
        onPeerIdentityLinked: (linkedPeer) => {
          // If the peer wasn't already explicitly verified via QR/manual validation,
          // link it as an unverified peer to trigger the verification gate
          if (!verifiedPeer?.isExplicitlyVerified || verifiedPeer.fingerprint !== linkedPeer.fingerprint) {
            const unverifiedPeer = { ...linkedPeer, isExplicitlyVerified: false, isAutoLinked: true };
            onSetVerifiedPeer(unverifiedPeer);
            saveSessionPeer(unverifiedPeer);
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
        onTtlChanged: (newTtl) => {
          setRoomTtlSeconds(newTtl);
          setFileTtlSeconds(Math.max(newTtl, 60));
          const opt = TTL_OPTIONS.find((o) => o.seconds === newTtl);
          const formatted = opt ? opt.label : `${newTtl}s`;
          setMessages((prev) => [
            ...prev,
            {
              id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              type: 'system',
              text: `⏱️ Disappearing timer set to ${formatted}`,
              timestamp: Date.now(),
            },
          ]);
          onShowToast(`⏱️ Disappearing timer set to ${formatted}`, 'info');
        },
        onBurnTriggered: (msgId, burnDelay) => {
          const deadline = Date.now() + (burnDelay || BURN_ON_READ_DELAY_SECONDS) * 1000;
          setMessages((prev) =>
            prev.map((msg) => {
              if (msg.id === msgId) {
                return {
                  ...msg,
                  renderedAt: Date.now(),
                  burnDeadline: Math.min(msg.burnDeadline || deadline, deadline),
                };
              }
              return msg;
            })
          );
        },
      },
      myIdentity,
      peerToUse,
      customServerUrl
    );

    sessionRef.current = session;
    return session;
  };

  const handleChangeRoomTtl = (seconds) => {
    setRoomTtlSeconds(seconds);
    setFileTtlSeconds(Math.max(seconds, 60));
    setShowTtlDropdown(false);
    if (sessionRef.current) {
      sessionRef.current.sendTtlChange(seconds);
    }
    const opt = TTL_OPTIONS.find((o) => o.seconds === seconds);
    const formatted = opt ? opt.label : `${seconds}s`;
    setMessages((prev) => [
      ...prev,
      {
        id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: 'system',
        text: `⏱️ Disappearing timer set to ${formatted}`,
        timestamp: Date.now(),
      },
    ]);
    onShowToast(`Disappearing timer set to ${formatted}`, 'success');
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

    const isPeerFullyVerified = Boolean(verifiedPeer?.isExplicitlyVerified);
    const isChatUnlocked = isPeerFullyVerified || isUnverifiedRiskAcknowledged;
    if (!isChatUnlocked) {
      onShowToast('Please verify peer identity or acknowledge risk to send messages', 'warning');
      return;
    }

    if (attachedFile && !isSendingFile) {
      await handleSendAttachedFile();
    }

    if (!inputText.trim()) return;

    const textToSend = inputText.trim();
    setInputText('');

    try {
      const sentMsg = await sessionRef.current.sendMessage(textToSend, {
        ttlSeconds: roomTtlSeconds,
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
    const isPeerFullyVerified = Boolean(verifiedPeer?.isExplicitlyVerified);
    const isChatUnlocked = isPeerFullyVerified || isUnverifiedRiskAcknowledged;
    if (!isChatUnlocked) {
      onShowToast('Please verify peer identity or acknowledge risk to send files', 'warning');
      return;
    }
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
    const isPeerFullyVerified = Boolean(verifiedPeer?.isExplicitlyVerified);
    const isChatUnlocked = isPeerFullyVerified || isUnverifiedRiskAcknowledged;
    if (!attachedFile || !sessionRef.current || status !== 'connected' || isSendingFile || !isChatUnlocked) return;

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
    const isPeerFullyVerified = Boolean(verifiedPeer?.isExplicitlyVerified);
    const isChatUnlocked = isPeerFullyVerified || isUnverifiedRiskAcknowledged;
    if (status === 'connected' && isChatUnlocked) setIsDraggingOver(true);
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

    const isPeerFullyVerified = Boolean(verifiedPeer?.isExplicitlyVerified);
    const isChatUnlocked = isPeerFullyVerified || isUnverifiedRiskAcknowledged;
    if (status !== 'connected' || !isChatUnlocked) return;
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
    setIsUnverifiedRiskAcknowledged(false);
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
      <div className="section-label">
        <span className="title">PEER-TO-PEER TUNNEL</span>

        <button
          type="button"
          onClick={() => setShowServerConfig(!showServerConfig)}
          className="cfg-btn"
        >
          <Server className="w-3.5 h-3.5 text-[#ffcf6b]" />
          <span>⚙ Server config</span>
          {showServerConfig ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </button>
      </div>

      {showServerConfig && (
        <div className="p-4 bg-[#111c14] border border-[#24392b] rounded-2xl space-y-3 text-xs shadow-xl animate-slide-up mx-2 sm:mx-6">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <span className="font-bold text-white font-mono">Signaling Server URL</span>
            <span className="text-[11px] text-[#5c9a6b] font-mono">Default: {getDefaultSignalingUrl()}</span>
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={customServerUrl}
              onChange={(e) => setCustomServerUrl(e.target.value)}
              disabled={status !== 'idle' && status !== 'disconnected' && status !== 'error'}
              placeholder={getDefaultSignalingUrl()}
              className="flex-1 bg-[#0b120e] border border-[#24392b] focus:border-[#8fe3a0] outline-none rounded-xl px-3 py-2 text-xs text-white placeholder:text-[#5c9a6b] font-mono transition-colors"
            />
            <button
              onClick={() => setCustomServerUrl(getDefaultSignalingUrl())}
              className="btn btn-secondary text-xs px-3 py-2"
            >
              Reset
            </button>
          </div>
        </div>
      )}

      {/* ======================================================================== */}
      {/* 1. LOBBY STATE (Soft Corner Choice Cards & Terminal Alignment)            */}
      {/* ========================================================================= */}
      {status === 'idle' || status === 'disconnected' || status === 'error' ? (
        <div className="space-y-4">
          {/* Reconnect Banner if peer is remembered in session */}
          {savedPeer && (
            <div className="p-4 mx-2 sm:mx-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 border border-[#24392b] bg-[#111c14] rounded-2xl shadow-lg animate-fade-in">
              <div className="flex items-center gap-3">
                <div className="p-2.5 rounded-xl bg-[#0b120e] border border-[#8fe3a0] text-[#8fe3a0] shadow-[0_0_10px_rgba(143,227,160,0.2)]">
                  <UserCheck className="w-4 h-4" />
                </div>
                <div>
                  <p className="text-xs font-bold text-white font-mono">Paired Peer Found</p>
                  <p className="text-xs text-[#8fe3a0] font-mono">
                    {savedPeer.fingerprint.slice(0, 16)}...
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 w-full sm:w-auto">
                <button
                  onClick={handleStartChat}
                  className="btn btn-primary text-xs py-2 px-3.5 flex-1 sm:flex-initial flex items-center justify-center gap-1.5"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Resume Chat</span>
                </button>
                <button
                  onClick={clearSessionPeer}
                  className="btn btn-secondary text-xs py-2 px-2.5 text-[#5c9a6b] hover:text-white"
                  title="Forget peer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}

          {/* Choice Cards (Start Chat & Join Chat) */}
          <div className="choices-grid">
            {/* Start Chat Card */}
            <div className="choice-card">
              <div className="space-y-3">
                <div className="icon-box">▦</div>
                <h3>START CHAT</h3>
                <p>
                  Create a secure room and show your QR code to your friend to connect.
                </p>
              </div>

              <button
                onClick={handleStartChat}
                className="btn btn-primary w-full py-3 text-xs font-bold flex items-center justify-center gap-2"
              >
                <span>▦ START CHAT &amp; SHOW QR</span>
              </button>
            </div>

            {/* Join Chat Card */}
            <div className="choice-card">
              <div className="space-y-3">
                <div className="icon-box">◉</div>
                <h3>JOIN CHAT</h3>
                <p>
                  Open your camera to scan your friend's QR code and automatically connect.
                </p>
              </div>

              <button
                onClick={() => startCameraScanner()}
                className="btn btn-ghost w-full py-3 text-xs font-bold flex items-center justify-center gap-2"
              >
                <span>◉ JOIN CHAT (SCAN QR)</span>
              </button>
            </div>
          </div>

          {/* Collapsible Manual Entry Strip */}
          <div
            className="manual-strip"
            onClick={() => setShowManualPeerInput(!showManualPeerInput)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setShowManualPeerInput(!showManualPeerInput);
              }
            }}
          >
            <span>▤ Enter room code or paste JSON manually</span>
            <span className="chev">{showManualPeerInput ? '▴' : '▾'}</span>
          </div>

          {showManualPeerInput && (
            <div className="p-5 mx-2 sm:mx-6 space-y-4 max-w-lg sm:mx-auto rounded-2xl bg-[#111c14] border border-[#24392b] shadow-xl animate-slide-up">
              <div className="flex items-center justify-between border-b border-[#24392b] pb-2">
                <span className="text-xs font-bold text-white font-mono">Manual Room Connect</span>
                <button
                  onClick={() => setShowManualPeerInput(false)}
                  className="text-[#5c9a6b] hover:text-[#8fe3a0]"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-2">
                <label className="text-[11px] font-medium text-[#7fa889] block font-mono">
                  6-Character Room Code:
                </label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    maxLength={6}
                    value={joinInput}
                    onChange={(e) => setJoinInput(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                    placeholder="E.G. ABC123"
                    className="flex-1 bg-[#0b120e] border border-[#24392b] focus:border-[#8fe3a0] outline-none rounded-xl px-3 py-2 font-mono text-center text-sm font-bold tracking-widest text-[#8fe3a0] uppercase transition-colors"
                  />
                  <button
                    onClick={() => handleDirectJoinRoom(joinInput)}
                    disabled={joinInput.length < 6}
                    className="btn btn-primary text-xs px-4 disabled:opacity-40"
                  >
                    Join
                  </button>
                </div>
              </div>

              <form onSubmit={handleManualPeerValidate} className="space-y-2 pt-2 border-t border-[#24392b]">
                <label className="text-[11px] font-medium text-[#7fa889] block font-mono">
                  Or Paste Raw Peer Identity JSON:
                </label>
                <textarea
                  rows={2}
                  value={rawPeerJsonInput}
                  onChange={(e) => setRawPeerJsonInput(e.target.value)}
                  placeholder='{"protocol":"covert-chatter",...}'
                  className="w-full bg-[#0b120e] border border-[#24392b] focus:border-[#8fe3a0] outline-none rounded-xl p-2.5 text-xs font-mono text-white placeholder:text-[#5c9a6b] transition-colors"
                />
                <div className="flex justify-end">
                  <button
                    type="submit"
                    disabled={!rawPeerJsonInput.trim()}
                    className="btn btn-secondary text-xs py-1.5 px-3 disabled:opacity-40"
                  >
                    Validate &amp; Link
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>
      ) : null}

      {/* ========================================================================= */}
      {/* 2. CAMERA SCANNER (Soft Corner Viewfinder)                                */}
      {/* ========================================================================= */}
      {isJoinScannerOpen && (
        <div 
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 animate-fade-in"
          onClick={(e) => {
            if (e.target === e.currentTarget) stopCameraScanner();
          }}
          role="dialog"
          aria-modal="true"
          aria-label="Scan QR Code"
        >
          <div className="bg-[#131f17] rounded-2xl max-w-sm w-full p-5 space-y-4 shadow-2xl border border-[#24392b] animate-scale-up relative">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Camera className="w-4 h-4 text-[#8fe3a0]" />
                <h3 className="text-sm font-bold text-white font-mono">Scan QR Code</h3>
              </div>
              <button
                onClick={stopCameraScanner}
                className="p-1 rounded-lg text-[#5c9a6b] hover:text-white hover:bg-[#18281e]"
                aria-label="Close scanner"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Viewfinder Frame */}
            <div className="relative rounded-xl overflow-hidden bg-black h-[260px] min-h-[260px] max-h-[260px] w-full flex items-center justify-center border border-[#24392b]">
              <div id={scannerContainerId} className="w-full h-full overflow-hidden rounded-lg flex items-center justify-center" />
              <div className="absolute inset-0 pointer-events-none flex items-center justify-center z-10">
                <div className="w-44 h-44 border-2 border-[#8fe3a0] rounded-2xl shadow-[0_0_18px_rgba(143,227,160,0.35)]" />
              </div>
            </div>

            {cameraError && (
              <p className="text-xs text-rose-400 bg-rose-500/10 p-2.5 rounded-xl border border-rose-500/30">
                {cameraError}
              </p>
            )}

            <div className="flex items-center justify-between gap-2 pt-1 border-t border-[#24392b]">
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
                className="btn btn-secondary text-xs py-2 px-3 flex items-center gap-1.5 flex-1 justify-center"
              >
                <FileImage className="w-3.5 h-3.5 text-[#8fe3a0]" />
                <span>{isProcessingFile ? 'Reading...' : 'Upload Image'}</span>
              </button>
              <button
                onClick={stopCameraScanner}
                className="btn btn-secondary text-xs py-2 px-3"
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
        <div className="p-6 sm:p-8 text-center max-w-md mx-auto space-y-5 rounded-2xl bg-[#111c14] border border-[#24392b] shadow-xl animate-scale-up">
          <div className="space-y-1">
            <span className="badge-neon text-xs">ROOM CREATED</span>
            <h3 className="text-base font-bold text-white font-mono">Show QR to Friend</h3>
            <p className="text-xs text-[#7fa889]">
              Scan this code with "Join Chat" to automatically pair
            </p>
          </div>

          <div className="p-3 sm:p-4 bg-white rounded-2xl border-2 border-[#8fe3a0] inline-block shadow-[0_0_20px_rgba(143,227,160,0.2)]">
            <QRCodeSVG
              value={hostQrPayload}
              size={230}
              level="L"
              includeMargin={true}
              bgColor="#FFFFFF"
              fgColor="#0b120e"
            />
          </div>

          <div className="space-y-1">
            <span className="text-[11px] text-[#5c9a6b] uppercase tracking-wider font-mono font-semibold">
              Room Code
            </span>
            <div className="flex items-center justify-center gap-2">
              <span className="font-mono text-xl font-bold tracking-widest text-[#8fe3a0] bg-[#0b120e] px-4 py-2 rounded-xl border border-[#24392b] select-all shadow-[0_0_10px_rgba(143,227,160,0.15)]">
                {roomCode}
              </span>
              <button
                onClick={handleCopyRoomCode}
                className="p-2.5 rounded-xl bg-[#0b120e] border border-[#24392b] hover:border-[#8fe3a0] text-[#8fe3a0] transition-all cursor-pointer"
                title="Copy Code"
              >
                {copiedCode ? <Check className="w-4 h-4 text-[#8fe3a0]" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div className="flex items-center justify-center gap-2 text-xs text-[#7fa889] pt-1">
            <Loader2 className="w-4 h-4 animate-spin text-[#8fe3a0]" />
            <span className="font-mono">Waiting for friend to connect...</span>
          </div>

          <div className="pt-2">
            <button
              onClick={handleDisconnect}
              className="btn btn-secondary text-xs py-2 px-4"
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
        <div className="p-8 text-center max-w-sm mx-auto space-y-4 rounded-2xl bg-[#111c14] border border-[#24392b] shadow-xl animate-scale-up">
          <div className="w-12 h-12 rounded-xl bg-[#0b120e] border border-[#8fe3a0] flex items-center justify-center text-[#8fe3a0] mx-auto shadow-[0_0_15px_rgba(143,227,160,0.2)]">
            <RefreshCw className="w-6 h-6 animate-spin" />
          </div>

          <div className="space-y-1">
            <h3 className="text-sm font-bold text-white font-mono">
              {verifiedPeer ? `Connecting to ${verifiedPeer.fingerprint.slice(0, 8)}...` : 'Connecting...'}
            </h3>
            <p className="text-xs text-[#7fa889]">
              Establishing end-to-end encrypted session
            </p>
          </div>

          <div className="pt-2">
            <button
              onClick={handleDisconnect}
              className="btn btn-secondary text-xs py-1.5 px-3"
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
        const isPeerFullyVerified = Boolean(verifiedPeer?.isExplicitlyVerified);
        const isChatUnlocked = isPeerFullyVerified || isUnverifiedRiskAcknowledged;
        const peerDisplayName = verifiedPeer?.fingerprint 
          ? `Peer ${verifiedPeer.fingerprint.slice(0, 8)}${isPeerFullyVerified ? ' ✓' : ' (Unverified)'}`
          : 'Connected Peer';

        return (
          <div 
            onDragOver={handleDragOver}
            onDragEnter={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`rounded-2xl border border-[#24392b] overflow-hidden flex flex-col chat-container-responsive relative transition-all bg-[#0b120e] shadow-2xl mx-1 sm:mx-4 ${
              isDraggingOver ? 'ring-2 ring-[#8fe3a0] bg-[#111c14]' : ''
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
              <div className="absolute inset-0 z-50 bg-[#111c14]/95 border-2 border-dashed border-[#8fe3a0] rounded-2xl flex flex-col items-center justify-center p-6 space-y-2 pointer-events-none animate-fade-in">
                <UploadCloud className="w-12 h-12 text-[#8fe3a0] animate-bounce" />
                <h3 className="text-sm font-bold text-white font-mono">Drop file to send</h3>
                <p className="text-xs text-[#8fe3a0]">Encrypted in 16KB blocks (Up to 25MB)</p>
              </div>
            )}

            {/* HEADER: Soft panel bg, mild green/slate border */}
            <div className="px-5 py-3 bg-[#111c14] border-b border-[#24392b] flex items-center justify-between gap-3 shrink-0 relative z-20 shadow-md">
              <div className="flex items-center gap-3 min-w-0">
                {/* Peer avatar */}
                <div className="relative shrink-0">
                  <div 
                    className="chat-avatar-40"
                    title={verifiedPeer?.fingerprint || 'Peer'}
                  >
                    {peerInitials}
                  </div>
                  {/* Connection dot */}
                  <span 
                    className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-[#8fe3a0] rounded-full border border-[#0b120e] shadow-[0_0_8px_rgba(143,227,160,0.8)]"
                    title="Connected"
                  />
                </div>

                {/* Peer Name & Room details */}
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="text-sm font-bold text-white font-mono truncate">
                      {peerDisplayName}
                    </h2>

                    {/* Connection status badge */}
                    <button
                      onClick={() => setShowSecurityModal(true)}
                      className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-[#0b120e] text-[#8fe3a0] border border-[#8fe3a0] shadow-[0_0_10px_rgba(143,227,160,0.2)] hover:bg-[#8fe3a0]/10 transition-all cursor-pointer font-mono"
                      title="Click for security & encryption details"
                    >
                      <Lock className="w-2.5 h-2.5 text-[#8fe3a0]" />
                      <span>Encrypted</span>
                    </button>

                    {/* Connection Type Pill */}
                    {connectionType && (
                      <span className="badge-neutral text-[10px] py-0.5 px-2">
                        {connectionType === 'direct' ? '⚡ Direct' : '🖥️ Relay'}
                      </span>
                    )}
                  </div>
                  <p className="text-[10px] text-[#5c9a6b] font-mono truncate">Room: {roomCode}</p>
                </div>
              </div>

              {/* Header Right: Disappearing Timer & Options */}
              <div className="flex items-center gap-2 shrink-0">
                {/* Disappearing Timer Selector Pill */}
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => {
                      setShowTtlDropdown(!showTtlDropdown);
                      setShowOptionsMenu(false);
                    }}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-xs font-mono font-bold bg-[#0b120e] text-[#8fe3a0] border border-[#24392b] hover:border-[#8fe3a0] shadow-xs transition-all cursor-pointer select-none"
                    title="Change Disappearing Messages Timer (Synchronized across all devices)"
                  >
                    <Clock className="w-3.5 h-3.5 text-[#8fe3a0]" />
                    <span>{formatRemainingTime(roomTtlSeconds)}</span>
                    <ChevronDown className={`w-3 h-3 text-[#5c9a6b] transition-transform duration-200 ${showTtlDropdown ? 'rotate-180' : ''}`} />
                  </button>

                  {/* Disappearing Timer Dropdown Menu */}
                  {showTtlDropdown && (
                    <>
                      <div 
                        className="fixed inset-0 z-30" 
                        onClick={() => setShowTtlDropdown(false)} 
                      />
                      <div className="absolute right-0 top-11 z-40 w-52 bg-[#131f17] rounded-2xl border border-[#24392b] p-2 shadow-2xl space-y-1 animate-scale-up">
                        <div className="px-3 py-2 border-b border-[#24392b]">
                          <p className="text-xs font-bold text-white font-mono flex items-center gap-1.5">
                            <Clock className="w-3.5 h-3.5 text-[#8fe3a0]" />
                            <span>Disappearing Messages</span>
                          </p>
                          <p className="text-[10px] text-[#5c9a6b]">Synchronized across all devices</p>
                        </div>

                        <div className="max-h-60 overflow-y-auto space-y-0.5 py-1">
                          {TTL_OPTIONS.map((opt) => {
                            const isSelected = roomTtlSeconds === opt.seconds;
                            return (
                              <button
                                key={opt.seconds}
                                type="button"
                                onClick={() => handleChangeRoomTtl(opt.seconds)}
                                className={`w-full text-left px-3 py-2 rounded-xl text-xs flex items-center justify-between transition-colors font-mono cursor-pointer ${
                                  isSelected 
                                    ? 'bg-[#8fe3a0]/15 text-[#8fe3a0] font-bold border border-[#8fe3a0]/30'
                                    : 'text-[#7fa889] hover:text-[#8fe3a0] hover:bg-[#18281e]'
                                }`}
                              >
                                <span>{opt.label}</span>
                                {isSelected && <Check className="w-3.5 h-3.5 text-[#8fe3a0]" />}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </>
                  )}
                </div>

                {/* Options Menu Button */}
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => {
                      setShowOptionsMenu(!showOptionsMenu);
                      setShowTtlDropdown(false);
                    }}
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
                      <div className="absolute right-0 top-11 z-40 w-56 bg-[#131f17] rounded-2xl border border-[#24392b] p-2 shadow-2xl space-y-1 animate-scale-up">
                        <div className="px-3 py-2 border-b border-[#24392b]">
                          <p className="text-xs font-bold text-white font-mono">Session Options</p>
                          <p className="text-[10px] text-[#5c9a6b] font-mono truncate">Room: {roomCode}</p>
                        </div>

                        <button
                          type="button"
                          onClick={() => {
                            setShowTtlDropdown(true);
                            setShowOptionsMenu(false);
                          }}
                          className="w-full text-left px-3 py-2 rounded-xl text-xs text-[#7fa889] hover:text-[#8fe3a0] hover:bg-[#18281e] flex items-center gap-2 transition-colors font-medium cursor-pointer"
                        >
                          <Clock className="w-3.5 h-3.5 text-[#8fe3a0]" />
                          <span>Disappearing Timer ({formatRemainingTime(roomTtlSeconds)})</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            handleCopyRoomCode();
                            setShowOptionsMenu(false);
                          }}
                          className="w-full text-left px-3 py-2 rounded-xl text-xs text-[#7fa889] hover:text-[#8fe3a0] hover:bg-[#18281e] flex items-center gap-2 transition-colors font-medium cursor-pointer"
                        >
                          <Copy className="w-3.5 h-3.5 text-[#8fe3a0]" />
                          <span>Copy Room Code</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setShowSecurityModal(true);
                            setShowOptionsMenu(false);
                          }}
                          className="w-full text-left px-3 py-2 rounded-xl text-xs text-[#7fa889] hover:text-[#8fe3a0] hover:bg-[#18281e] flex items-center gap-2 transition-colors font-medium cursor-pointer"
                        >
                          <ShieldCheck className="w-3.5 h-3.5 text-[#8fe3a0]" />
                          <span>Security &amp; Encryption</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setShowOptionsMenu(false);
                            handleDisconnect();
                          }}
                          className="w-full text-left px-3 py-2 rounded-xl text-xs text-rose-400 hover:bg-rose-500/15 flex items-center gap-2 transition-colors font-semibold cursor-pointer border-t border-[#24392b] mt-1"
                        >
                          <Trash2 className="w-3.5 h-3.5 text-rose-400" />
                          <span>Leave Room &amp; Wipe</span>
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Security Details Modal */}
            {showSecurityModal && (
              <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4 animate-fade-in">
                <div className="bg-[#131f17] rounded-2xl max-w-sm w-full p-5 space-y-4 shadow-2xl border border-[#24392b] animate-scale-up">
                  <div className="flex items-center justify-between border-b border-[#24392b] pb-2">
                    <div className="flex items-center gap-2 text-[#8fe3a0]">
                      <ShieldCheck className="w-5 h-5 text-[#8fe3a0]" />
                      <h3 className="text-sm font-bold text-white font-mono">Session Security</h3>
                    </div>
                    <button
                      onClick={() => setShowSecurityModal(false)}
                      className="p-1 text-[#5c9a6b] hover:text-white rounded-lg"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="space-y-2.5 text-xs text-[#7fa889]">
                    <div className="p-2.5 bg-[#0b120e] border border-[#24392b] rounded-xl space-y-1">
                      <p className="font-bold text-white font-mono">Symmetric Encryption</p>
                      <p className="font-mono text-[11px] text-[#8fe3a0]">AES-256-GCM (Fresh 12-byte IV per message)</p>
                    </div>
                    <div className="p-2.5 bg-[#0b120e] border border-[#24392b] rounded-xl space-y-1">
                      <p className="font-bold text-white font-mono">Digital Signatures</p>
                      <p className="font-mono text-[11px] text-[#8fe3a0]">ECDSA P-256 (SHA-256 Digest)</p>
                    </div>
                    <div className="p-2.5 bg-[#0b120e] border border-[#24392b] rounded-xl space-y-1">
                      <p className="font-bold text-white font-mono">Key Agreement</p>
                      <p className="font-mono text-[11px] text-[#8fe3a0]">ECDH P-256 (Diffie-Hellman Shared Secret)</p>
                    </div>
                    <div className="p-2.5 bg-[#0b120e] border border-[#24392b] rounded-xl space-y-1">
                      <p className="font-bold text-white font-mono">Ephemeral Storage</p>
                      <p className="text-[11px] text-[#5c9a6b]">Volatile RAM only. Wiped on leave, tab close, or 30s background blur.</p>
                    </div>
                  </div>

                  <button
                    onClick={() => setShowSecurityModal(false)}
                    className="btn btn-secondary w-full py-2 text-xs"
                  >
                    Close
                  </button>
                </div>
              </div>
            )}

            {/* Mandatory Peer Verification Gate Warning Banner (Task 3) */}
            {!isChatUnlocked && (
              <div className="mx-4 mt-3 mb-1 p-4 rounded-2xl bg-[#18281e] border border-[#ffcf6b]/50 shadow-xl space-y-3 animate-fade-in text-left">
                <div className="flex items-start gap-3">
                  <div className="w-9 h-9 rounded-xl bg-[#ffcf6b]/15 border border-[#ffcf6b]/50 flex items-center justify-center text-[#ffcf6b] shrink-0 mt-0.5">
                    <AlertTriangle className="w-5 h-5" />
                  </div>
                  <div className="space-y-1 flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h4 className="text-xs font-bold text-white font-mono uppercase tracking-wider">
                        Unverified Peer Identity
                      </h4>
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#ffcf6b]/20 text-[#ffcf6b] border border-[#ffcf6b]/40 font-mono font-semibold">
                        Security Warning
                      </span>
                    </div>
                    <p className="text-xs text-[#e2f5e7] leading-relaxed">
                      This peer's identity has not been confirmed via QR code scan or manual fingerprint comparison. A network attacker or compromised signaling relay could potentially be executing a Man-In-The-Middle (MITM) attack to intercept this session.
                    </p>
                    {verifiedPeer?.fingerprint && (
                      <div className="pt-1 font-mono text-[11px] text-[#8fe3a0] bg-[#0b120e] px-2.5 py-1 rounded-lg border border-[#24392b] select-all truncate">
                        Peer Fingerprint: {verifiedPeer.fingerprint}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2.5 pt-1 border-t border-[#24392b] flex-wrap">
                  <button
                    type="button"
                    onClick={startCameraScanner}
                    className="btn btn-primary text-xs py-2 px-3 flex items-center gap-1.5"
                  >
                    <QrCode className="w-3.5 h-3.5" />
                    <span>Scan QR to Verify</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setIsUnverifiedRiskAcknowledged(true)}
                    className="btn btn-secondary text-xs py-2 px-3 text-[#ffcf6b] hover:text-white border-[#ffcf6b]/40 hover:border-[#ffcf6b]"
                  >
                    I Understand the Risk — Allow Chat
                  </button>
                </div>
              </div>
            )}

            {/* CHAT BUBBLES STREAM */}
            <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-3.5 bg-[#0b120e]">
              {messages.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center p-6 text-[#5c9a6b] space-y-3">
                  <div className="w-12 h-12 rounded-xl bg-[#111c14] border border-[#8fe3a0] flex items-center justify-center text-[#8fe3a0] shadow-[0_0_15px_rgba(143,227,160,0.2)]">
                    <Sparkles className="w-6 h-6" />
                  </div>
                  <p className="text-sm font-bold text-white font-mono">Encrypted Tunnel Established</p>
                  <p className="text-xs text-[#5c9a6b] max-w-xs leading-relaxed">
                    End-to-end encrypted with AES-256-GCM. Pure ephemeral RAM storage.
                  </p>
                </div>
              ) : (
                messages.map((msg) => {
                  if (msg.type === 'system') {
                    return (
                      <div key={msg.id} className="flex justify-center my-2 animate-fade-in">
                        <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#111c14] border border-[#24392b] text-[#8fe3a0] text-[11px] font-mono shadow-xs">
                          <Clock className="w-3 h-3 text-[#8fe3a0]" />
                          <span>{msg.text}</span>
                        </div>
                      </div>
                    );
                  }

                  const isMe = msg.sender === 'me';
                  const remainingSecs = getRemainingSeconds(msg, currentTime);
                  const isBurn = msg.burnOnRead;
                  const isFile = msg.type === 'file';
                  const timeStr = msg.timestamp
                    ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    : '';

                  if (isMe) {
                    return (
                      <div
                        key={msg.id}
                        className={`flex justify-end items-end gap-2.5 animate-fade-in ${
                          remainingSecs <= 2 ? 'opacity-40 transition-opacity' : 'opacity-100'
                        }`}
                      >
                        {/* Outside Left: Countdown Badge & Timestamp */}
                        <div className="flex flex-col items-end gap-1 select-none pb-1 shrink-0">
                          {isBurn ? (
                            <span className="inline-flex items-center gap-1 font-bold text-[10px] text-[#0b120e] bg-[#ffcf6b] border border-[#ffcf6b] px-1.5 py-0.5 rounded-full shadow-[0_0_8px_rgba(255,207,107,0.35)]">
                              <Flame className="w-2.5 h-2.5 text-[#0b120e] fill-[#0b120e] animate-pulse" />
                              <span>{formatRemainingTime(remainingSecs)}</span>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 font-mono text-[10px] text-[#8fe3a0] bg-[#111c14] border border-[#24392b] px-1.5 py-0.5 rounded-full shadow-xs">
                              <Clock className="w-2.5 h-2.5 text-[#8fe3a0]" />
                              <span>{formatRemainingTime(remainingSecs)}</span>
                            </span>
                          )}
                          <div className="flex items-center gap-1 text-[10px] font-mono text-[#5c9a6b]">
                            <Check className="w-3 h-3 text-[#8fe3a0] stroke-[2.5]" />
                            <span>{timeStr}</span>
                          </div>
                        </div>

                        {/* Mine Bubble Container */}
                        <div className="max-w-[75%] flex justify-end min-w-0">
                          <div className="bubble-mine">
                            {isFile ? (
                              <div className="space-y-2 min-w-[200px] sm:min-w-[240px]">
                                {msg.status !== 'completed' ? (
                                  <div className="space-y-1.5 pt-1">
                                    <div className="flex items-center justify-between text-[10px] text-[#0b120e]/80 font-mono">
                                      <span>{msg.status === 'receiving' ? 'Receiving...' : 'Sending...'}</span>
                                      <span>{msg.progress || 0}%</span>
                                    </div>
                                    <div className="w-full h-2 rounded-full overflow-hidden bg-black/20">
                                      <div
                                        className="h-full transition-all duration-150 bg-[#0b120e]"
                                        style={{ width: `${msg.progress || 0}%` }}
                                      />
                                    </div>
                                  </div>
                                ) : msg.blobUrl && msg.mimeType?.startsWith('image/') ? (
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
                                      <span className="text-[10px] font-mono text-[#0b120e]/80 truncate max-w-[130px]">
                                        {msg.fileName}
                                      </span>
                                      <a
                                        href={msg.blobUrl}
                                        download={msg.fileName}
                                        onClick={() => handleTriggerFileBurn(msg.id)}
                                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold bg-[#0b120e] text-[#8fe3a0] hover:bg-black transition-all shadow-xs"
                                      >
                                        <Download className="w-2.5 h-2.5 text-[#8fe3a0]" />
                                        <span>Save</span>
                                      </a>
                                    </div>
                                  </div>
                                ) : (
                                  <div className="space-y-2">
                                    <div className="flex items-start gap-2.5">
                                      <div className="p-2 rounded-xl bg-black/15 text-[#0b120e] shrink-0">
                                        <FileText className="w-4 h-4" />
                                      </div>
                                      <div className="flex-1 min-w-0">
                                        <p className="text-xs sm:text-sm font-bold text-[#0b120e] truncate" title={msg.fileName}>
                                          {msg.fileName}
                                        </p>
                                        <span className="text-[10px] text-[#0b120e]/80 font-mono">
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
                                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold bg-[#0b120e] text-[#8fe3a0] hover:bg-black transition-all shadow-md"
                                        >
                                          <Download className="w-3 h-3 text-[#8fe3a0]" />
                                          <span>Download</span>
                                        </a>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <p className="text-[14px] sm:text-[15px] leading-relaxed font-normal whitespace-pre-wrap text-[#0b120e] m-0">
                                {msg.text}
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  } else {
                    return (
                      <div
                        key={msg.id}
                        className={`flex items-end gap-2.5 animate-fade-in ${
                          remainingSecs <= 2 ? 'opacity-40 transition-opacity' : 'opacity-100'
                        }`}
                      >
                        {/* Peer Avatar */}
                        <div 
                          className="w-8 h-8 min-w-[32px] min-h-[32px] rounded-xl border border-[#24392b] bg-[#111c14] text-[#8fe3a0] font-bold text-xs flex items-center justify-center font-mono select-none shrink-0 shadow-xs"
                          title={verifiedPeer?.fingerprint || 'Peer'}
                        >
                          {peerInitials}
                        </div>

                        {/* Peer Message Stack */}
                        <div className="flex flex-col items-start max-w-[75%] min-w-0">
                          <span className="text-[10px] font-mono font-bold text-[#5c9a6b] ml-1 mb-1 select-none">
                            {peerDisplayName}
                          </span>

                          <div className="flex items-end gap-2.5">
                            <div className="bubble-peer">
                              {isFile ? (
                                <div className="space-y-2 min-w-[200px] sm:min-w-[240px]">
                                  {msg.status !== 'completed' ? (
                                    <div className="space-y-1.5 pt-1">
                                      <div className="flex items-center justify-between text-[10px] text-[#5c9a6b] font-mono">
                                        <span>Receiving...</span>
                                        <span>{msg.progress || 0}%</span>
                                      </div>
                                      <div className="w-full h-2 rounded-full overflow-hidden bg-black/30">
                                        <div
                                          className="h-full transition-all duration-150 bg-[#8fe3a0]"
                                          style={{ width: `${msg.progress || 0}%` }}
                                        />
                                      </div>
                                    </div>
                                  ) : msg.blobUrl && msg.mimeType?.startsWith('image/') ? (
                                    <div className="space-y-1.5">
                                      <div 
                                        className="rounded-xl overflow-hidden bg-black/30 border border-[#24392b] cursor-pointer max-h-56 max-w-xs group relative"
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
                                        <span className="text-[10px] font-mono text-[#7fa889] truncate max-w-[130px]">
                                          {msg.fileName}
                                        </span>
                                        <a
                                          href={msg.blobUrl}
                                          download={msg.fileName}
                                          onClick={() => handleTriggerFileBurn(msg.id)}
                                          className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-bold bg-[#0b120e] text-[#8fe3a0] hover:bg-black transition-all shadow-xs border border-[#24392b]"
                                        >
                                          <Download className="w-2.5 h-2.5 text-[#8fe3a0]" />
                                          <span>Save</span>
                                        </a>
                                      </div>
                                    </div>
                                  ) : (
                                    <div className="space-y-2">
                                      <div className="flex items-start gap-2.5">
                                        <div className="p-2 rounded-xl bg-[#0b120e] text-[#8fe3a0] shrink-0 border border-[#24392b]">
                                          <FileText className="w-4 h-4" />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                          <p className="text-xs sm:text-sm font-bold text-white truncate" title={msg.fileName}>
                                            {msg.fileName}
                                          </p>
                                          <span className="text-[10px] text-[#5c9a6b] font-mono">
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
                                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold bg-[#0b120e] text-[#8fe3a0] hover:bg-black transition-all shadow-md border border-[#24392b]"
                                          >
                                            <Download className="w-3 h-3 text-[#8fe3a0]" />
                                            <span>Download</span>
                                          </a>
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <p className="text-[14px] sm:text-[15px] leading-relaxed font-normal whitespace-pre-wrap text-[#e2f5e7] m-0">
                                  {msg.text}
                                </p>
                              )}
                            </div>

                            {/* Outside Right: Countdown Badge & Timestamp */}
                            <div className="flex flex-col items-start gap-1 select-none pb-1 shrink-0">
                              {isBurn ? (
                                <span className="inline-flex items-center gap-1 font-bold text-[10px] text-[#0b120e] bg-[#ffcf6b] border border-[#ffcf6b] px-1.5 py-0.5 rounded-full shadow-[0_0_8px_rgba(255,207,107,0.35)]">
                                  <Flame className="w-2.5 h-2.5 text-[#0b120e] fill-[#0b120e] animate-pulse" />
                                  <span>{formatRemainingTime(remainingSecs)}</span>
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 font-mono text-[10px] text-[#8fe3a0] bg-[#111c14] border border-[#24392b] px-1.5 py-0.5 rounded-full shadow-xs">
                                  <Clock className="w-2.5 h-2.5 text-[#8fe3a0]" />
                                  <span>{formatRemainingTime(remainingSecs)}</span>
                                </span>
                              )}
                              <span className="text-[10px] font-mono text-[#5c9a6b]">{timeStr}</span>
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
              <div className="px-4 py-2.5 bg-[#111c14] border-t border-[#24392b] flex items-center justify-between gap-3 text-xs animate-slide-up">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-7 h-7 rounded-xl border border-[#8fe3a0] bg-[#0b120e] flex items-center justify-center text-[#8fe3a0] shrink-0">
                    <File className="w-3.5 h-3.5" />
                  </div>
                  <span className="font-bold text-white truncate max-w-[180px] sm:max-w-xs">{attachedFile.name}</span>
                  <span className="text-[#5c9a6b] shrink-0 font-mono">({formatFileSize(attachedFile.size)})</span>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => setFileBurnOnRead(!fileBurnOnRead)}
                    className={`px-2.5 py-1 rounded-full text-[10px] font-bold flex items-center gap-1 border transition-colors cursor-pointer ${
                      fileBurnOnRead
                        ? 'bg-[#ffcf6b] text-[#0b120e] border-[#ffcf6b] shadow-[0_0_8px_rgba(255,207,107,0.3)]'
                        : 'bg-[#0b120e] text-[#7fa889] border-[#24392b] hover:border-[#8fe3a0]'
                    }`}
                    title="Burn file on read"
                  >
                    <Flame className="w-3 h-3" />
                    <span>Burn</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setAttachedFile(null)}
                    className="w-7 h-7 rounded-full border border-[#24392b] bg-[#0b120e] hover:bg-[#18281e] text-[#5c9a6b] hover:text-white flex items-center justify-center cursor-pointer"
                    title="Cancel attachment"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>

                  <button
                    type="button"
                    onClick={handleSendAttachedFile}
                    disabled={isSendingFile}
                    className="btn btn-primary text-xs py-1 px-3 flex items-center gap-1.5 rounded-full disabled:opacity-40"
                  >
                    {isSendingFile ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                    <span>Send</span>
                  </button>
                </div>
              </div>
            )}

            {/* Input Footer */}
            <div className="p-3 sm:p-4 bg-[#111c14] border-t border-[#24392b] shrink-0 shadow-lg">
              <form onSubmit={handleSendMessage} className="flex items-center gap-2 sm:gap-3">
                {/* Attach icon button */}
                <button
                  type="button"
                  onClick={handleOpenFilePicker}
                  disabled={!isChatUnlocked}
                  className="chat-icon-btn w-10 h-10 min-w-[40px] min-h-[40px] disabled:opacity-30 disabled:cursor-not-allowed"
                  title={!isChatUnlocked ? "Verify peer identity to enable file attachments" : "Attach File or Photo (Encrypted P2P)"}
                  aria-label="Attach file"
                >
                  <Paperclip className="w-4.5 h-4.5 text-[#8fe3a0] hover:text-[#a5edb4]" />
                </button>

                {/* Text input with soft rounded pill */}
                <div className="flex-1 bg-[#0b120e] border border-[#24392b] focus-within:border-[#8fe3a0] focus-within:shadow-[0_0_10px_rgba(143,227,160,0.15)] rounded-xl px-4 h-10 transition-all flex items-center">
                  <input
                    type="text"
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    disabled={!isChatUnlocked}
                    placeholder={
                      !isChatUnlocked 
                        ? "Peer unverified — scan QR or acknowledge risk above to chat..." 
                        : (attachedFile ? "Add a message or press send..." : "Type an encrypted message...")
                    }
                    className="w-full bg-transparent border-none outline-none text-xs sm:text-sm text-white placeholder:text-[#5c9a6b] py-1 font-mono disabled:opacity-40 disabled:cursor-not-allowed"
                  />
                </div>

                {/* Right buttons (timer-select, burn-toggle, send) */}
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => setShowTtlDropdown(!showTtlDropdown)}
                    className="chat-icon-btn w-10 h-10 min-w-[40px] min-h-[40px]"
                    title={`Disappearing Timer: ${formatRemainingTime(roomTtlSeconds)} (Click to change)`}
                    aria-label="Change disappearing timer"
                  >
                    <Clock className="w-4.5 h-4.5 text-[#8fe3a0]" />
                  </button>

                  <button
                    type="button"
                    onClick={() => setBurnOnReadEnabled(!burnOnReadEnabled)}
                    className={`chat-icon-btn w-10 h-10 min-w-[40px] min-h-[40px] ${
                      burnOnReadEnabled
                        ? 'bg-[#ffcf6b] text-[#0b120e] border-[#ffcf6b] shadow-[0_0_12px_rgba(255,207,107,0.35)]'
                        : ''
                    }`}
                    title={burnOnReadEnabled ? `Burn on Read: Active (${BURN_ON_READ_DELAY_SECONDS}s)` : 'Turn on Burn-on-Read'}
                    aria-label="Toggle burn on read"
                  >
                    <Flame className={`w-4.5 h-4.5 ${burnOnReadEnabled ? 'fill-[#0b120e] text-[#0b120e]' : ''}`} />
                  </button>

                  <button
                    type="submit"
                    disabled={!isChatUnlocked || (!inputText.trim() && !attachedFile)}
                    className="chat-send-btn w-10 h-10 min-w-[40px] min-h-[40px] disabled:opacity-30 disabled:cursor-not-allowed"
                    title={!isChatUnlocked ? "Verify peer identity to enable sending" : "Send encrypted message or file"}
                    aria-label="Send message"
                  >
                    <Send className="w-4 h-4 ml-0.5 text-[#0b120e]" />
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
          className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex flex-col items-center justify-center p-4 animate-fade-in"
          onClick={() => setPreviewImage(null)}
        >
          <div 
            className="relative max-w-2xl w-full flex flex-col items-center gap-3 animate-scale-up"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Top Bar */}
            <div className="w-full flex items-center justify-between px-2 text-xs">
              <span className="text-white font-mono font-bold truncate max-w-xs">{previewImage.name}</span>
              <div className="flex items-center gap-2">
                <a
                  href={previewImage.url}
                  download={previewImage.name}
                  className="btn btn-primary text-xs py-1.5 px-3 flex items-center gap-1.5 rounded-xl"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Download</span>
                </a>
                <button
                  onClick={() => setPreviewImage(null)}
                  className="w-8 h-8 rounded-xl bg-[#131f17] border border-[#24392b] text-white hover:bg-[#18281e] flex items-center justify-center cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Image display */}
            <div className="rounded-2xl overflow-hidden border border-[#24392b] bg-[#0b120e] shadow-2xl max-h-[75vh] flex items-center justify-center">
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
