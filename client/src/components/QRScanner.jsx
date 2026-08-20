import React, { useState, useEffect, useRef } from 'react';
import { Html5Qrcode, Html5QrcodeSupportedFormats } from 'html5-qrcode';
import { 
  Camera, 
  CameraOff, 
  AlertCircle, 
  Copy, 
  Check, 
  UserCheck, 
  RotateCcw, 
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
        onShowToast('Peer identity verified!', 'success');
        stopCamera();
      } else {
        setValidationError(validation.error || 'Invalid identity payload structure.');
        onShowToast(validation.error || 'Invalid QR code', 'error');
      }
    } catch (err) {
      setValidationError(`Verification error: ${err.message}`);
      onShowToast('Failed to process payload', 'error');
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
        experimentalFeatures: {
          useBarCodeDetectorIfSupported: true,
        },
      });
      scannerRef.current = html5QrCode;

      const qrCodeSuccessCallback = (decodedText) => {
        processPayload(decodedText);
      };

      const qrCodeErrorCallback = () => {};

      const config = {
        fps: 15,
        qrbox: (viewfinderWidth, viewfinderHeight) => {
          const minEdge = Math.min(viewfinderWidth, viewfinderHeight);
          const size = Math.max(220, Math.floor(minEdge * 0.85));
          return { width: size, height: size };
        },
        aspectRatio: 1.0,
      };

      // Try camera discovery first for optimal hardware matching
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
        // Fall back to constraint if enumeration fails
      }

      try {
        await html5QrCode.start(
          cameraDeviceOrConfig,
          config,
          qrCodeSuccessCallback,
          qrCodeErrorCallback
        );
      } catch (firstErr) {
        // If back camera / specific config failed, try user facing camera
        await html5QrCode.start(
          { facingMode: 'user' },
          config,
          qrCodeSuccessCallback,
          qrCodeErrorCallback
        );
      }

      setIsScanning(true);
    } catch (err) {
      console.error('Camera startup error:', err);
      let msg = 'Failed to access camera. Please check browser permissions.';
      if (err.name === 'NotAllowedError' || err.message?.includes('Permission')) {
        msg = 'Camera permission denied. Please allow camera access in your browser settings.';
      } else if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') {
        msg = 'No compatible camera found. You can scan by uploading an image of the QR code.';
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
      setValidationError('Could not detect a valid QR code in this image.');
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
      onShowToast('Peer fingerprint copied', 'success');
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
      <div 
        id="file-qr-temp-reader" 
        style={{ position: 'fixed', top: '-9999px', left: '-9999px', width: '250px', height: '250px', opacity: 0, pointerEvents: 'none' }} 
      />

      {!scannedPeer ? (
        <div className="glass-panel p-6 sm:p-8 space-y-5 bg-[#1C1C1C] border-[#A8CC19]/40">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <Camera className="w-4 h-4 text-[#D4FF27]" />
                Scan Peer Identity
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Scan another user's Covert Chatter QR code to authenticate cryptographic keys.
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
                <FileImage className="w-3.5 h-3.5 text-[#A8CC19]" />
                <span>{isProcessingFile ? 'Reading...' : 'Upload Image'}</span>
              </button>

              {!isScanning ? (
                <button
                  onClick={startCamera}
                  className="btn-primary text-xs py-2 px-3 flex items-center gap-1.5"
                >
                  <Camera className="w-3.5 h-3.5" />
                  <span>Start Camera</span>
                </button>
              ) : (
                <button
                  onClick={stopCamera}
                  className="btn-danger text-xs py-2 px-3 flex items-center gap-1.5"
                >
                  <CameraOff className="w-3.5 h-3.5" />
                  <span>Stop Camera</span>
                </button>
              )}
            </div>
          </div>

          {/* Viewfinder Container */}
          <div className="relative rounded-2xl overflow-hidden bg-black min-h-[300px] flex items-center justify-center border border-[#A8CC19]/40">
            <div id={scannerContainerId} className="w-full max-w-sm overflow-hidden rounded-xl" />

            {!isScanning && (
              <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center bg-black/90 gap-3">
                <div className="w-12 h-12 rounded-2xl bg-[#1C1C1C] border border-[#D4FF27] flex items-center justify-center text-[#D4FF27] shadow-[0_0_12px_rgba(212,255,39,0.25)]">
                  <Camera className="w-6 h-6" />
                </div>
                <p className="text-xs text-slate-300">
                  Click "Start Camera" above or upload an image file of a QR code.
                </p>
              </div>
            )}
          </div>

          {cameraError && (
            <p className="text-xs text-rose-400 bg-rose-500/10 p-3 rounded-xl border border-rose-500/30">
              {cameraError}
            </p>
          )}

          {validationError && (
            <p className="text-xs text-amber-400 bg-amber-500/10 p-3 rounded-xl border border-amber-500/30">
              {validationError}
            </p>
          )}
        </div>
      ) : (
        /* Scanned Peer Verification Card */
        <div className="glass-panel p-6 sm:p-8 space-y-5 bg-[#1C1C1C] border-[#A8CC19]/50">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="p-2.5 bg-[#121212] border border-[#D4FF27] rounded-xl text-[#D4FF27] shadow-[0_0_10px_rgba(212,255,39,0.2)]">
                <UserCheck className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white">Peer Identity Authenticated</h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Verified NIST P-256 ECDSA & ECDH parameters.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={handleConnectWithPeer}
                className="btn-primary text-xs py-2 px-3.5 flex items-center gap-1.5"
              >
                <Lock className="w-3.5 h-3.5" />
                <span>Connect</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={handleResetScan}
                className="btn-secondary text-xs py-2 px-3 flex items-center gap-1.5"
              >
                <RotateCcw className="w-3.5 h-3.5 text-[#A8CC19]" />
                <span>Scan Another</span>
              </button>
            </div>
          </div>

          {/* Verified Fingerprint Display */}
          <div className="space-y-1">
            <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Peer SHA-256 Fingerprint
            </label>
            <div className="bg-[#121212] border border-[#A8CC19]/50 rounded-xl p-3 relative group">
              <div className="font-mono text-[#D4FF27] font-semibold text-xs sm:text-sm tracking-wider break-all select-all pr-12">
                {scannedPeer.fingerprint}
              </div>
              <button
                onClick={handleCopyPeerFingerprint}
                className="absolute right-2.5 top-2.5 p-1.5 rounded-lg bg-[#1C1C1C] border border-[#A8CC19]/50 text-slate-300 hover:text-[#D4FF27] shadow-xs cursor-pointer transition-colors"
                title="Copy Fingerprint"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-[#D4FF27]" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
