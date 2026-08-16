import React, { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { 
  Copy, 
  Check, 
  RefreshCw, 
  ShieldCheck, 
  KeyRound, 
  AlertTriangle, 
  QrCode,
  Download,
  Share2
} from 'lucide-react';

export default function MyIdentity({ identity, onRegenerate, onShowToast }) {
  const [copiedField, setCopiedField] = useState(null);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);

  if (!identity || !identity.publicJWKs) {
    return (
      <div className="glass-panel p-8 text-center text-slate-400">
        <div className="animate-pulse flex flex-col items-center gap-3">
          <KeyRound className="w-8 h-8 text-emerald-400" />
          <p>Generating cryptographically secure identity...</p>
        </div>
      </div>
    );
  }

  // Canonical payload formatted for QR encoding & peer verification
  const qrPayload = JSON.stringify({
    protocol: 'covert-chatter',
    version: 1,
    fingerprint: identity.fingerprint,
    ecdsa: identity.publicJWKs.ecdsa,
    ecdh: identity.publicJWKs.ecdh,
  });

  const handleCopy = async (text, fieldName, successMsg) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(fieldName);
      onShowToast(successMsg, 'success');
      setTimeout(() => setCopiedField(null), 2000);
    } catch {
      onShowToast('Failed to copy to clipboard', 'error');
    }
  };

  const handleConfirmRegenerate = async () => {
    try {
      setIsRegenerating(true);
      await onRegenerate();
      setShowConfirmModal(false);
      onShowToast('New cryptographic identity generated successfully', 'success');
    } catch (err) {
      onShowToast(err.message || 'Failed to regenerate identity', 'error');
    } finally {
      setIsRegenerating(false);
    }
  };

  const handleDownloadQR = () => {
    try {
      const svg = document.getElementById('identity-qr-code');
      if (!svg) return;
      const svgData = new XMLSerializer().serializeToString(svg);
      const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
      const svgUrl = URL.createObjectURL(svgBlob);
      const downloadLink = document.createElement('a');
      downloadLink.href = svgUrl;
      downloadLink.download = `covert-identity-${identity.fingerprint.slice(0, 8).replace(/\s/g, '')}.svg`;
      document.body.appendChild(downloadLink);
      downloadLink.click();
      document.body.removeChild(downloadLink);
      URL.revokeObjectURL(svgUrl);
      onShowToast('QR Code saved as SVG', 'info');
    } catch {
      onShowToast('Failed to download QR code', 'error');
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Top Header Card */}
      <div className="glass-panel p-6 sm:p-8 rounded-2xl relative overflow-hidden">
        <div className="absolute -right-16 -top-16 w-48 h-48 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none" />
        <div className="absolute -left-16 -bottom-16 w-48 h-48 bg-cyan-500/10 rounded-full blur-3xl pointer-events-none" />

        <div className="flex flex-col md:flex-row items-center gap-8 justify-between">
          {/* Left: QR Display */}
          <div className="flex flex-col items-center gap-3">
            <div className="p-4 bg-white rounded-2xl shadow-xl shadow-emerald-950/40 border border-emerald-500/20 relative group">
              <QRCodeSVG
                id="identity-qr-code"
                value={qrPayload}
                size={210}
                level="M"
                includeMargin={false}
                bgColor="#FFFFFF"
                fgColor="#090d16"
              />
            </div>
            
            <div className="flex items-center gap-2">
              <button
                onClick={handleDownloadQR}
                className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5"
                title="Download QR SVG"
              >
                <Download className="w-3.5 h-3.5 text-cyan-400" />
                <span>Save QR</span>
              </button>
              <button
                onClick={() => handleCopy(qrPayload, 'payload', 'Identity QR payload copied to clipboard')}
                className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5"
                title="Copy raw JSON payload"
              >
                {copiedField === 'payload' ? (
                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                ) : (
                  <Share2 className="w-3.5 h-3.5 text-emerald-400" />
                )}
                <span>Share Payload</span>
              </button>
            </div>
          </div>

          {/* Right: Identity Details & Controls */}
          <div className="flex-1 w-full space-y-4">
            <div className="flex items-center gap-2">
              <span className="badge-emerald flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5" />
                Hardware Keystore Isolated
              </span>
              <span className="badge-cyan">
                Web Crypto P-256
              </span>
            </div>

            <div>
              <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
                Public Fingerprint
              </h2>
              <p className="text-xs text-slate-400 mt-1">
                Visual SHA-256 digest of your combined ECDSA & ECDH public keys. Compare with peers out-of-band to verify connection integrity.
              </p>
            </div>

            {/* Fingerprint Box */}
            <div className="bg-slate-900/90 border border-slate-800 rounded-xl p-3.5 relative group hover:border-emerald-500/40 transition-colors">
              <div className="font-mono text-emerald-400 font-semibold text-sm sm:text-base tracking-wider break-all select-all">
                {identity.fingerprint}
              </div>
              <button
                onClick={() => handleCopy(identity.fingerprint, 'fingerprint', 'Fingerprint copied to clipboard')}
                className="absolute right-2.5 top-2.5 p-1.5 rounded-lg bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-white transition-all shadow"
                title="Copy Fingerprint"
              >
                {copiedField === 'fingerprint' ? (
                  <Check className="w-4 h-4 text-emerald-400" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
              </button>
            </div>

            {/* Keypair Summary */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
              <div className="p-3 bg-slate-900/60 border border-slate-800/80 rounded-xl">
                <div className="text-xs text-slate-400 font-medium">Signing Algorithm</div>
                <div className="text-sm font-semibold text-slate-200 mt-0.5">ECDSA NIST P-256</div>
                <div className="text-[11px] text-emerald-400/80 mt-1">Non-extractable Private Key</div>
              </div>
              <div className="p-3 bg-slate-900/60 border border-slate-800/80 rounded-xl">
                <div className="text-xs text-slate-400 font-medium">Key Agreement</div>
                <div className="text-sm font-semibold text-slate-200 mt-0.5">ECDH NIST P-256</div>
                <div className="text-[11px] text-cyan-400/80 mt-1">Non-extractable Private Key</div>
              </div>
            </div>

            {/* Actions */}
            <div className="flex flex-wrap items-center gap-3 pt-2">
              <button
                onClick={() => handleCopy(qrPayload, 'raw_json', 'Full identity JSON copied')}
                className="btn-primary text-sm flex items-center gap-2 flex-1 justify-center"
              >
                {copiedField === 'raw_json' ? (
                  <>
                    <Check className="w-4 h-4 text-emerald-300" />
                    <span>Copied Identity JSON</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-4 h-4" />
                    <span>Copy Raw Public Identity</span>
                  </>
                )}
              </button>

              <button
                onClick={() => setShowConfirmModal(true)}
                className="btn-danger text-sm flex items-center gap-2 px-4 justify-center"
                title="Regenerate cryptographic keypairs"
              >
                <RefreshCw className="w-4 h-4" />
                <span>Regenerate</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Confirmation Modal */}
      {showConfirmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
          <div className="glass-panel border-rose-500/30 max-w-md w-full p-6 rounded-2xl space-y-4 shadow-2xl animate-scale-up">
            <div className="flex items-center gap-3 text-rose-400">
              <div className="p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/20">
                <AlertTriangle className="w-6 h-6" />
              </div>
              <h3 className="text-lg font-bold text-white">Regenerate Cryptographic Identity?</h3>
            </div>

            <p className="text-sm text-slate-300 leading-relaxed">
              Generating new keys will permanently overwrite your existing private keys in IndexedDB.
            </p>

            <div className="p-3 bg-rose-950/40 border border-rose-800/40 rounded-xl text-xs text-rose-300/90 leading-relaxed">
              <strong>Warning:</strong> Any peers who previously verified your fingerprint will see a key mismatch. Active or saved peer connections will be broken.
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                onClick={() => setShowConfirmModal(false)}
                disabled={isRegenerating}
                className="btn-secondary text-sm"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmRegenerate}
                disabled={isRegenerating}
                className="btn-danger text-sm flex items-center gap-2"
              >
                {isRegenerating ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin" />
                    <span>Regenerating...</span>
                  </>
                ) : (
                  <span>Yes, Overwrite & Regenerate</span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
