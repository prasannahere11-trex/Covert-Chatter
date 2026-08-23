import React, { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { 
  Copy, 
  Check, 
  RefreshCw, 
  ShieldCheck, 
  KeyRound, 
  AlertTriangle, 
  Download,
  Share2
} from 'lucide-react';

export default function MyIdentity({ identity, onRegenerate, onShowToast }) {
  const [copiedField, setCopiedField] = useState(null);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);

  if (!identity || !identity.publicJWKs) {
    return (
      <div className="glass-panel p-8 text-center text-slate-400 bg-[#202020] border-[#337418]/30">
        <div className="animate-pulse flex flex-col items-center gap-3">
          <KeyRound className="w-8 h-8 text-[#5DD62C]" />
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
      <div className="glass-panel p-6 sm:p-8 bg-[#202020] border-[#337418]/40 shadow-xl">
        <div className="flex flex-col md:flex-row items-center md:items-start gap-8 justify-between">
          {/* Left: QR Display */}
          <div className="flex flex-col items-center gap-3">
            <div className="p-3 sm:p-4 bg-white rounded-2xl border-2 border-[#5DD62C] shadow-[0_0_25px_rgba(93,214,44,0.25)] relative">
              <QRCodeSVG
                id="identity-qr-code"
                value={qrPayload}
                size={240}
                level="L"
                includeMargin={true}
                bgColor="#FFFFFF"
                fgColor="#0F0F0F"
              />
            </div>
            
            <div className="flex items-center gap-2">
              <button
                onClick={handleDownloadQR}
                className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5"
                title="Download QR SVG"
              >
                <Download className="w-3.5 h-3.5 text-[#5DD62C]" />
                <span>Save QR</span>
              </button>
              <button
                onClick={() => handleCopy(qrPayload, 'payload', 'Identity QR payload copied to clipboard')}
                className="btn-secondary text-xs py-1.5 px-3 flex items-center gap-1.5"
                title="Copy raw JSON payload"
              >
                {copiedField === 'payload' ? (
                  <Check className="w-3.5 h-3.5 text-[#5DD62C]" />
                ) : (
                  <Share2 className="w-3.5 h-3.5 text-[#5DD62C]" />
                )}
                <span>Share Payload</span>
              </button>
            </div>
          </div>

          {/* Right: Identity Details & Controls */}
          <div className="flex-1 w-full space-y-4">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="badge-neon flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5" />
                Hardware Keystore Isolated
              </span>
              <span className="badge-neutral text-[11px]">
                Web Crypto P-256
              </span>
            </div>

            <div>
              <h2 className="text-lg font-bold text-white">
                Public Fingerprint
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                SHA-256 digest of your combined ECDSA & ECDH public keys.
              </p>
            </div>

            {/* Fingerprint Box */}
            <div className="bg-[#0F0F0F] border border-[#337418]/50 rounded-xl p-3 relative group">
              <div className="font-mono text-[#5DD62C] font-semibold text-xs sm:text-sm tracking-wider break-all select-all pr-12">
                {identity.fingerprint}
              </div>
              <button
                onClick={() => handleCopy(identity.fingerprint, 'fingerprint', 'Fingerprint copied')}
                className="absolute right-2.5 top-2.5 p-1.5 rounded-lg bg-[#202020] border border-[#337418]/50 text-slate-300 hover:text-[#5DD62C] shadow-xs cursor-pointer transition-colors"
                title="Copy Fingerprint"
              >
                {copiedField === 'fingerprint' ? (
                  <Check className="w-3.5 h-3.5 text-[#5DD62C]" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
              </button>
            </div>

            {/* Keypair Summary */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              <div className="p-3 bg-[#0F0F0F] border border-[#337418]/30 rounded-xl">
                <div className="text-xs text-slate-400 font-medium">Signing Algorithm</div>
                <div className="text-sm font-semibold text-white mt-0.5">ECDSA NIST P-256</div>
                <div className="text-[11px] text-[#5DD62C] mt-0.5">Non-extractable Private Key</div>
              </div>
              <div className="p-3 bg-[#0F0F0F] border border-[#337418]/30 rounded-xl">
                <div className="text-xs text-slate-400 font-medium">Key Agreement</div>
                <div className="text-sm font-semibold text-white mt-0.5">ECDH NIST P-256</div>
                <div className="text-[11px] text-[#5DD62C] mt-0.5">Non-extractable Private Key</div>
              </div>
            </div>

            {/* Actions */}
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <button
                onClick={() => handleCopy(qrPayload, 'raw_json', 'Full identity JSON copied')}
                className="btn-primary text-xs py-2.5 px-4 flex items-center gap-1.5 flex-1 justify-center"
              >
                {copiedField === 'raw_json' ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-[#0F0F0F]" />
                    <span>Copied JSON</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>Copy Raw Public Identity</span>
                  </>
                )}
              </button>

              <button
                onClick={() => setShowConfirmModal(true)}
                className="btn-danger text-xs py-2.5 px-3.5 flex items-center gap-1.5 justify-center"
                title="Regenerate cryptographic keypairs"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Regenerate</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Confirmation Modal */}
      {showConfirmModal && (
        <div 
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md animate-fade-in"
          onClick={(e) => {
            if (e.target === e.currentTarget && !isRegenerating) {
              setShowConfirmModal(false);
            }
          }}
          role="dialog"
          aria-modal="true"
        >
          <div className="bg-[#202020] border border-[#337418]/50 max-w-sm w-full p-5 rounded-2xl space-y-4 shadow-2xl animate-scale-up">
            <div className="flex items-center gap-2.5 text-rose-400">
              <AlertTriangle className="w-5 h-5" />
              <h3 className="text-base font-bold text-white">Regenerate Identity?</h3>
            </div>

            <p className="text-xs text-slate-300 leading-relaxed">
              Generating new keys will overwrite your existing private keys in IndexedDB. Previous paired connections will need to be re-paired.
            </p>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={() => setShowConfirmModal(false)}
                disabled={isRegenerating}
                className="btn-secondary text-xs py-1.5 px-3"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmRegenerate}
                disabled={isRegenerating}
                className="btn-danger text-xs py-1.5 px-3 flex items-center gap-1.5"
              >
                {isRegenerating ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    <span>Regenerating...</span>
                  </>
                ) : (
                  <span>Regenerate</span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
