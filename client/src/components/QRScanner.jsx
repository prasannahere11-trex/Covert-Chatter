import React, { useState, useEffect, useRef } from 'react';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';
import { 
  Camera, 
  CameraOff, 
  Upload, 
  CheckCircle2, 
  AlertCircle, 
  Copy, 
  Check, 
  UserCheck, 
  RotateCcw, 
  KeyRound, 
  ShieldAlert,
  FileImage,
  ArrowRight,
  Lock
} from 'lucide-react';
import { validatePeerIdentityPayload } from '../utils/crypto';

export default function QRScanner({ onShowToast, onPeerVerified, onNavigateToConnect }) {
  const [isScanning, setIsScanning] = useState(false);
  const [cameraError, setCameraError] = useState(null);
  const [scannedPeer, setScannedPeer] = useState(null);
  const [validationError, setValidationError] = useState(null);
  const [copied, setCopied] = useState(false);
  const [isProcessingFile, setIsProcessingFile] = useState(false);

  const scannerRef = useRef(null);
  const fileInputRef = useRef(null);
  const scannerContainerId = 'covert-qr-reader';

  const stopCamera = async () => {
    if (scannerRef.current) {
      try {
        if (scannerRef.current.isScanning) {
          await scannerRef.current.stop();
        }
        await scannerRef.current.clear();
      } catch (err) {
        console.warn('Error stopping scanner:', err);
      }
      scannerRef.current = null;
    }
    setIsScanning(false);
  };

  const processPayload = async (decodedText) => {
    try {
      const validation = await validatePeerIdentityPayload(decodedText);
      if (validation.valid && validation.peerIdentity) {
        setScannedPeer(validation.peerIdentity);
        setValidationError(null);
        if (onPeerVerified) {
          onPeerVerified(validation.peerIdentity);
        }
        onShowToast('Peer identity verified successfully!', 'success');
        stopCamera();
      } else {
        setValidationError(validation.error || 'Invalid identity payload structure.');
        onShowToast(validation.error || 'Invalid QR code payload', 'error');
      }
    } catch (err) {
      setValidationError(`Verification error: ${err.message}`);
      onShowToast('Failed to process scanned payload', 'error');
    }
  };

  const startCamera = async () => {
    setCameraError(null);
    setValidationError(null);

    try {
      await stopCamera();

      const html5QrCode = new Html5Qrcode(scannerContainerId, {
        formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
        verbose: false,
      });
      scannerRef.current = html5QrCode;

      const qrCodeSuccessCallback = (decodedText) => {
        processPayload(decodedText);
      };

      const qrCodeErrorCallback = (errorMessage) => {
        // Suppress frame-by-frame scanning noise
      };

      const config = {
        fps: 10,
        qrbox: { width: 240, height: 240 },
        aspectRatio: 1.0,
      };

      await html5QrCode.start(
        { facingMode: 'environment' },
        config,
        qrCodeSuccessCallback,
        qrCodeErrorCallback
      );

      setIsScanning(true);
    } catch (err) {
      console.error('Camera startup error:', err);
      let msg = 'Failed to access camera. Please check browser permissions.';
      if (err.name === 'NotAllowedError' || err.message?.includes('Permission')) {
        msg = 'Camera permission denied. Please allow camera access in your browser settings.';
      } else if (err.name === 'NotFoundError') {
        msg = 'No camera found on this device. You can still scan by uploading an image.';
      }
      setCameraError(msg);
      setIsScanning(false);
      onShowToast(msg, 'error');
    }
  };

  const handleFileUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsProcessingFile(true);
    setValidationError(null);

    try {
      const html5QrCode = new Html5Qrcode('file-qr-temp-reader', {
        formatsToSupport: [Html5QrcodeSupportedFormats.QR_CODE],
        verbose: false,
      });

      const decodedText = await html5QrCode.scanFile(file, true);
      await html5QrCode.clear();
      await processPayload(decodedText);
    } catch (err) {
      console.error('File scan error:', err);
      setValidationError('Could not detect a valid QR code in this image. Please try another image.');
      onShowToast('Could not find QR code in image', 'warning');
    } finally {
      setIsProcessingFile(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleCopyPeerFingerprint = async () => {
    if (!scannedPeer?.fingerprint) return;
    try {
      await navigator.clipboard.writeText(scannedPeer.fingerprint);
      setCopied(true);
      onShowToast('Peer fingerprint copied to clipboard', 'success');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      onShowToast('Failed to copy', 'error');
    }
  };

  const handleResetScan = () => {
    setScannedPeer(null);
    setValidationError(null);
    setCameraError(null);
  };

  const handleConnectWithPeer = () => {
    if (scannedPeer && onPeerVerified) {
      onPeerVerified(scannedPeer);
    }
    if (onNavigateToConnect) {
      onNavigateToConnect();
    }
  };

  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, []);

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Hidden container for file scanner helper */}
      <div id="file-qr-temp-reader" style={{ display: 'none' }} />

      {!scannedPeer ? (
        <div className="glass-panel p-6 sm:p-8 rounded-2xl space-y-6">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
                <Camera className="w-5 h-5 text-cyan-400" />
                Scan Peer Identity
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                Scan another user's Covert Chatter QR code to authenticate their public ECDSA and ECDH cryptographic keys.
              </p>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileUpload}
                accept="image/*"
                className="hidden"
                id="qr-file-upload"
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={isProcessingFile}
                className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5"
              >
                <FileImage className="w-4 h-4 text-emerald-400" />
                <span>{isProcessingFile ? 'Reading...' : 'Upload Image'}</span>
              </button>

              {!isScanning ? (
                <button
                  onClick={startCamera}
                  className="btn-primary text-xs py-2 px-3 flex items-center gap-1.5"
                >
                  <Camera className="w-4 h-4" />
                  <span>Start Camera</span>
                </button>
              ) : (
                <button
                  onClick={stopCamera}
                  className="btn-danger text-xs py-2 px-3 flex items-center gap-1.5"
                >
                  <CameraOff className="w-4 h-4" />
                  <span>Stop Camera</span>
                </button>
              )}
            </div>
          </div>

          {/* Viewfinder Container */}
          <div className="relative rounded-2xl overflow-hidden bg-slate-950 border border-slate-800 min-h-[320px] flex items-center justify-center">
            <div id={scannerContainerId} className="w-full max-w-sm overflow-hidden rounded-xl" />

            {!isScanning && (
              <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center bg-slate-950/90 backdrop-blur-sm gap-4">
                <div className="w-16 h-16 rounded-2xl bg-cyan-950/60 border border-cyan-500/30 flex items-center justify-center text-cyan-400 shadow-lg shadow-cyan-950/50">
                  <Camera className="w-8 h-8" />
                </div>
                <div className="max-w-xs space-y-1">
                  <p className="text-sm font-semibold text-slate-200">Camera is Idle</p>
                  <p className="text-xs text-slate-400">
                    Click "Start Camera" above or upload an image file of a peer's identity QR code.
                  </p>
                </div>
                <button
                  onClick={startCamera}
                  className="btn-primary text-xs py-2 px-4 flex items-center gap-2"
                >
                  <Camera className="w-4 h-4" />
                  <span>Launch Live Scanner</span>
                </button>
              </div>
            )}

            {/* Custom Scanner Frame Overlay when active */}
            {isScanning && (
              <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                <div className="w-64 h-64 border-2 border-emerald-400/80 rounded-2xl relative animate-pulse shadow-[0_0_20px_rgba(16,185,129,0.3)]">
                  <div className="absolute top-0 left-0 w-4 h-4 border-t-4 border-l-4 border-emerald-400 -mt-1 -ml-1 rounded-tl" />
                  <div className="absolute top-0 right-0 w-4 h-4 border-t-4 border-r-4 border-emerald-400 -mt-1 -mr-1 rounded-tr" />
                  <div className="absolute bottom-0 left-0 w-4 h-4 border-b-4 border-l-4 border-emerald-400 -mb-1 -ml-1 rounded-bl" />
                  <div className="absolute bottom-0 right-0 w-4 h-4 border-b-4 border-r-4 border-emerald-400 -mb-1 -mr-1 rounded-br" />
                </div>
              </div>
            )}
          </div>

          {/* Camera Permission / Access Error */}
          {cameraError && (
            <div className="p-4 bg-rose-950/50 border border-rose-800/60 rounded-xl flex items-start gap-3 text-rose-300 text-xs leading-relaxed animate-fade-in">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
              <div>
                <p className="font-semibold text-rose-200">Camera Access Notice</p>
                <p className="mt-0.5">{cameraError}</p>
              </div>
            </div>
          )}

          {/* Validation Error */}
          {validationError && (
            <div className="p-4 bg-amber-950/50 border border-amber-800/60 rounded-xl flex items-start gap-3 text-amber-300 text-xs leading-relaxed animate-fade-in">
              <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
              <div>
                <p className="font-semibold text-amber-200">Invalid QR Payload</p>
                <p className="mt-0.5">{validationError}</p>
              </div>
            </div>
          )}
        </div>
      ) : (
        /* Scanned Peer Verification Card */
        <div className="glass-panel p-6 sm:p-8 rounded-2xl space-y-6 animate-scale-up border-emerald-500/40">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-xl text-emerald-400">
                <UserCheck className="w-6 h-6" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-lg font-bold text-white">Peer Identity Authenticated</h3>
                  <span className="badge-emerald text-[11px]">Valid Cryptographic Proof</span>
                </div>
                <p className="text-xs text-slate-400 mt-0.5">
                  Verified NIST P-256 ECDSA signing key & ECDH key agreement parameters.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={handleConnectWithPeer}
                className="btn-primary text-xs py-2 px-3.5 flex items-center gap-1.5"
              >
                <Lock className="w-3.5 h-3.5" />
                <span>Use in Connect Room</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={handleResetScan}
                className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Scan Another</span>
              </button>
            </div>
          </div>

          {/* Verified Fingerprint Display */}
          <div className="space-y-2">
            <label className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
              Peer SHA-256 Fingerprint
            </label>
            <div className="bg-slate-900/90 border border-emerald-500/30 rounded-xl p-4 relative group">
              <div className="font-mono text-emerald-400 font-bold text-sm sm:text-base tracking-wider break-all select-all">
                {scannedPeer.fingerprint}
              </div>
              <button
                onClick={handleCopyPeerFingerprint}
                className="absolute right-3 top-3 p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition-all"
                title="Copy Peer Fingerprint"
              >
                {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
            <p className="text-[11px] text-slate-400">
              Tip: Read the first and last 4 characters over a trusted voice or in-person channel to verify peer authenticity.
            </p>
          </div>

          {/* Peer Key Coordinates Preview */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="p-4 bg-slate-900/60 border border-slate-800 rounded-xl space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-200">Peer ECDSA Signing Key</span>
                <span className="text-[10px] font-mono text-emerald-400">P-256</span>
              </div>
              <div className="text-[11px] font-mono text-slate-400 space-y-1 bg-slate-950 p-2.5 rounded-lg border border-slate-800/80">
                <div>x: {scannedPeer.ecdsa.x.slice(0, 16)}...</div>
                <div>y: {scannedPeer.ecdsa.y.slice(0, 16)}...</div>
              </div>
            </div>

            <div className="p-4 bg-slate-900/60 border border-slate-800 rounded-xl space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-200">Peer ECDH Agreement Key</span>
                <span className="text-[10px] font-mono text-cyan-400">P-256</span>
              </div>
              <div className="text-[11px] font-mono text-slate-400 space-y-1 bg-slate-950 p-2.5 rounded-lg border border-slate-800/80">
                <div>x: {scannedPeer.ecdh.x.slice(0, 16)}...</div>
                <div>y: {scannedPeer.ecdh.y.slice(0, 16)}...</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
