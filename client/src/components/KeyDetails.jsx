import React, { useState } from 'react';
import { 
  Key, 
  Lock, 
  Shield, 
  Copy, 
  Check, 
  Layers,
  Cpu
} from 'lucide-react';

export default function KeyDetails({ identity, onShowToast }) {
  const [copiedKey, setCopiedKey] = useState(null);

  if (!identity || !identity.publicJWKs) {
    return (
      <div className="glass-panel p-8 text-center text-slate-400 bg-[#202020] border-[#337418]/30">
        <p>No identity keys loaded.</p>
      </div>
    );
  }

  const ecdsaFormatted = JSON.stringify(identity.publicJWKs.ecdsa, null, 2);
  const ecdhFormatted = JSON.stringify(identity.publicJWKs.ecdh, null, 2);

  const handleCopy = async (text, keyName, label) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(keyName);
      onShowToast(`${label} copied to clipboard`, 'success');
      setTimeout(() => setCopiedKey(null), 2000);
    } catch {
      onShowToast('Failed to copy', 'error');
    }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Security Architecture Explainer Banner */}
      <div className="p-6 sm:p-8 bg-[#111c14] border border-[#24392b] rounded-2xl">
        <div className="flex items-start gap-4">
          <div className="p-2.5 bg-[#0b120e] border border-[#8fe3a0] rounded-xl text-[#8fe3a0] shrink-0 shadow-[0_0_10px_rgba(143,227,160,0.2)]">
            <Lock className="w-5 h-5" />
          </div>
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-bold text-white font-mono">
                What Does "Non-Extractable" Mean?
              </h2>
              <span className="badge-neon text-[11px]">Hardware &amp; Keystore Isolated</span>
            </div>
            <p className="text-xs sm:text-sm text-[#7fa889] leading-relaxed">
              When Covert Chatter generates your cryptographic keypairs, the private keys are created with{' '}
              <code className="font-mono text-[#8fe3a0] bg-[#0b120e] px-1.5 py-0.5 rounded border border-[#24392b] text-xs">
                extractable: false
              </code>
              . This instructs the browser's Web Crypto engine to lock the private key bytes inside a secure, sandboxed isolation boundary.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2 text-xs">
              <div className="p-3 bg-[#0b120e] rounded-xl border border-[#24392b] space-y-1">
                <div className="flex items-center gap-1.5 text-white font-semibold font-mono">
                  <Shield className="w-3.5 h-3.5 text-[#8fe3a0]" />
                  <span>XSS Protection</span>
                </div>
                <p className="text-[#5c9a6b]">
                  Rogue browser scripts cannot call <code className="font-mono text-[10px] text-[#8fe3a0]">exportKey()</code> to steal your private key bytes.
                </p>
              </div>

              <div className="p-3 bg-[#0b120e] rounded-xl border border-[#24392b] space-y-1">
                <div className="flex items-center gap-1.5 text-white font-semibold font-mono">
                  <Cpu className="w-3.5 h-3.5 text-[#8fe3a0]" />
                  <span>SubtleCrypto Isolation</span>
                </div>
                <p className="text-[#5c9a6b]">
                  Signatures and derivations execute inside the browser's native cryptographic module.
                </p>
              </div>

              <div className="p-3 bg-[#0b120e] rounded-xl border border-[#24392b] space-y-1">
                <div className="flex items-center gap-1.5 text-white font-semibold font-mono">
                  <Layers className="w-3.5 h-3.5 text-[#8fe3a0]" />
                  <span>Structured Persistence</span>
                </div>
                <p className="text-[#5c9a6b]">
                  Keys are cloned into IndexedDB as opaque <code className="font-mono text-[10px] text-[#8fe3a0]">CryptoKey</code> handles without exposing plaintext.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Raw JWK Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* ECDSA Signing JWK */}
        <div className="p-5 bg-[#111c14] border border-[#24392b] rounded-2xl space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="p-2 bg-[#0b120e] border border-[#24392b] rounded-lg text-[#8fe3a0]">
                <Key className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-xs font-bold text-white font-mono">ECDSA P-256 Public JWK</h3>
                <span className="text-[11px] text-[#5c9a6b]">Digital Signature Key</span>
              </div>
            </div>
            <button
              onClick={() => handleCopy(ecdsaFormatted, 'ecdsa', 'ECDSA Public JWK')}
              className="btn btn-secondary text-xs py-1 px-2.5 flex items-center gap-1"
            >
              {copiedKey === 'ecdsa' ? (
                <Check className="w-3 h-3 text-[#8fe3a0]" />
              ) : (
                <Copy className="w-3 h-3 text-[#8fe3a0]" />
              )}
              <span>Copy</span>
            </button>
          </div>

          <pre className="p-3 bg-[#0b120e] border border-[#24392b] rounded-xl text-[11px] font-mono text-[#8fe3a0] overflow-x-auto max-h-60 select-all leading-relaxed">
            {ecdsaFormatted}
          </pre>
        </div>

        {/* ECDH Key Agreement JWK */}
        <div className="p-5 bg-[#111c14] border border-[#24392b] rounded-2xl space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="p-2 bg-[#0b120e] border border-[#24392b] rounded-lg text-[#8fe3a0]">
                <Key className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-xs font-bold text-white font-mono">ECDH P-256 Public JWK</h3>
                <span className="text-[11px] text-[#5c9a6b]">Diffie-Hellman Key Agreement</span>
              </div>
            </div>
            <button
              onClick={() => handleCopy(ecdhFormatted, 'ecdh', 'ECDH Public JWK')}
              className="btn btn-secondary text-xs py-1 px-2.5 flex items-center gap-1"
            >
              {copiedKey === 'ecdh' ? (
                <Check className="w-3 h-3 text-[#8fe3a0]" />
              ) : (
                <Copy className="w-3 h-3 text-[#8fe3a0]" />
              )}
              <span>Copy</span>
            </button>
          </div>

          <pre className="p-3 bg-[#0b120e] border border-[#24392b] rounded-xl text-[11px] font-mono text-[#8fe3a0] overflow-x-auto max-h-60 select-all leading-relaxed">
            {ecdhFormatted}
          </pre>
        </div>
      </div>
    </div>
  );
}
