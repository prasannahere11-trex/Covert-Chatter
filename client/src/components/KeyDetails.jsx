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
      <div className="glass-panel p-8 text-center text-slate-400 bg-white">
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
      <div className="glass-panel p-6 sm:p-8 bg-white border-slate-200">
        <div className="flex items-start gap-4">
          <div className="p-2.5 bg-sage-50 border border-sage-200 rounded-xl text-sage-600 shrink-0">
            <Lock className="w-5 h-5" />
          </div>
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-bold text-slate-900">
                What Does "Non-Extractable" Mean?
              </h2>
              <span className="badge-sage text-[11px]">Hardware & Sandboxed Keystore</span>
            </div>
            <p className="text-xs sm:text-sm text-slate-600 leading-relaxed">
              When Covert Chatter generates your cryptographic keypairs, the private keys are created with{' '}
              <code className="font-mono text-sage-700 bg-slate-100 px-1 py-0.5 rounded text-xs">
                extractable: false
              </code>
              . This instructs the browser's Web Crypto engine to lock the private key bytes inside a secure, sandboxed isolation boundary.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2 text-xs">
              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 space-y-1">
                <div className="flex items-center gap-1.5 text-slate-800 font-semibold">
                  <Shield className="w-3.5 h-3.5 text-sage-600" />
                  <span>XSS Protection</span>
                </div>
                <p className="text-slate-500">
                  Rogue browser scripts cannot call <code className="font-mono text-[10px]">exportKey()</code> to steal your private key bytes.
                </p>
              </div>

              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 space-y-1">
                <div className="flex items-center gap-1.5 text-slate-800 font-semibold">
                  <Cpu className="w-3.5 h-3.5 text-sage-600" />
                  <span>SubtleCrypto Isolation</span>
                </div>
                <p className="text-slate-500">
                  Signatures and derivations execute inside the browser's native cryptographic module.
                </p>
              </div>

              <div className="p-3 bg-slate-50 rounded-xl border border-slate-200 space-y-1">
                <div className="flex items-center gap-1.5 text-slate-800 font-semibold">
                  <Layers className="w-3.5 h-3.5 text-sage-600" />
                  <span>Structured Persistence</span>
                </div>
                <p className="text-slate-500">
                  Keys are cloned into IndexedDB as opaque <code className="font-mono text-[10px]">CryptoKey</code> handles without exposing plaintext.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Raw JWK Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* ECDSA Signing JWK */}
        <div className="glass-panel p-5 bg-white space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="p-2 bg-slate-100 rounded-lg text-slate-700">
                <Key className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-xs font-bold text-slate-900">ECDSA P-256 Public JWK</h3>
                <span className="text-[11px] text-slate-400">Digital Signature Key</span>
              </div>
            </div>
            <button
              onClick={() => handleCopy(ecdsaFormatted, 'ecdsa', 'ECDSA Public JWK')}
              className="btn-secondary text-xs py-1 px-2.5 flex items-center gap-1"
            >
              {copiedKey === 'ecdsa' ? (
                <Check className="w-3 h-3 text-sage-600" />
              ) : (
                <Copy className="w-3 h-3" />
              )}
              <span>Copy</span>
            </button>
          </div>

          <pre className="p-3 bg-slate-50 border border-slate-200 rounded-xl text-[11px] font-mono text-slate-800 overflow-x-auto select-all leading-relaxed">
            {ecdsaFormatted}
          </pre>
        </div>

        {/* ECDH Key Agreement JWK */}
        <div className="glass-panel p-5 bg-white space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="p-2 bg-slate-100 rounded-lg text-slate-700">
                <Key className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-xs font-bold text-slate-900">ECDH P-256 Public JWK</h3>
                <span className="text-[11px] text-slate-400">Diffie-Hellman Key Agreement</span>
              </div>
            </div>
            <button
              onClick={() => handleCopy(ecdhFormatted, 'ecdh', 'ECDH Public JWK')}
              className="btn-secondary text-xs py-1 px-2.5 flex items-center gap-1"
            >
              {copiedKey === 'ecdh' ? (
                <Check className="w-3 h-3 text-sage-600" />
              ) : (
                <Copy className="w-3 h-3" />
              )}
              <span>Copy</span>
            </button>
          </div>

          <pre className="p-3 bg-slate-50 border border-slate-200 rounded-xl text-[11px] font-mono text-slate-800 overflow-x-auto select-all leading-relaxed">
            {ecdhFormatted}
          </pre>
        </div>
      </div>
    </div>
  );
}
