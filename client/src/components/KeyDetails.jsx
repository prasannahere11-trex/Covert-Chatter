import React, { useState } from 'react';
import { 
  Key, 
  Lock, 
  Shield, 
  Copy, 
  Check, 
  FileCode, 
  Info, 
  Layers,
  Cpu
} from 'lucide-react';

export default function KeyDetails({ identity, onShowToast }) {
  const [copiedKey, setCopiedKey] = useState(null);

  if (!identity || !identity.publicJWKs) {
    return (
      <div className="glass-panel p-8 text-center text-slate-400">
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
      <div className="glass-panel p-6 sm:p-8 rounded-2xl border-cyan-500/30 relative overflow-hidden">
        <div className="flex items-start gap-4">
          <div className="p-3 bg-cyan-500/10 border border-cyan-500/30 rounded-xl text-cyan-400 shrink-0">
            <Lock className="w-6 h-6" />
          </div>
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-bold text-white">
                What Does "Non-Extractable" Mean for Security?
              </h2>
              <span className="badge-emerald text-[11px]">Hardware & Sandboxed Keystore</span>
            </div>
            <p className="text-sm text-slate-300 leading-relaxed">
              When Whisper Drop generates your cryptographic keypairs, the private keys are created with{' '}
              <code className="font-mono text-emerald-400 bg-slate-900 px-1.5 py-0.5 rounded border border-slate-800 text-xs">
                extractable: false
              </code>
              . This instructs the browser's Web Crypto engine to lock the private key bytes inside a secure, sandboxed isolation boundary.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2 text-xs text-slate-300">
              <div className="p-3 bg-slate-900/60 rounded-xl border border-slate-800 space-y-1">
                <div className="flex items-center gap-1.5 text-emerald-400 font-semibold">
                  <Shield className="w-3.5 h-3.5" />
                  <span>XSS Theft Protection</span>
                </div>
                <p className="text-slate-400">
                  Even if malicious code or a rogue browser extension runs on the page, it cannot call <code className="font-mono text-[10px]">exportKey()</code> to steal your private key bytes.
                </p>
              </div>

              <div className="p-3 bg-slate-900/60 rounded-xl border border-slate-800 space-y-1">
                <div className="flex items-center gap-1.5 text-cyan-400 font-semibold">
                  <Cpu className="w-3.5 h-3.5" />
                  <span>SubtleCrypto Black Box</span>
                </div>
                <p className="text-slate-400">
                  Signing and key derivations happen entirely inside the browser's secure cryptographic module. Only the output signature or derived key is returned.
                </p>
              </div>

              <div className="p-3 bg-slate-900/60 rounded-xl border border-slate-800 space-y-1">
                <div className="flex items-center gap-1.5 text-amber-400 font-semibold">
                  <Layers className="w-3.5 h-3.5" />
                  <span>Isolated Persistence</span>
                </div>
                <p className="text-slate-400">
                  Keys are safely cloned into IndexedDB as opaque <code className="font-mono text-[10px]">CryptoKey</code> handles without ever exposing raw private key material to disk plaintext.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Raw JWK Cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ECDSA Signing JWK */}
        <div className="glass-panel p-6 rounded-2xl space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="p-2 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-emerald-400">
                <Key className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-white">ECDSA P-256 Public JWK</h3>
                <span className="text-[11px] text-slate-400">Digital Signature & Identity Proof</span>
              </div>
            </div>
            <button
              onClick={() => handleCopy(ecdsaFormatted, 'ecdsa', 'ECDSA Public JWK')}
              className="btn-secondary text-xs py-1 px-2.5 flex items-center gap-1"
            >
              {copiedKey === 'ecdsa' ? (
                <Check className="w-3.5 h-3.5 text-emerald-400" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
              <span>Copy</span>
            </button>
          </div>

          <div className="space-y-1 text-xs">
            <div className="flex justify-between text-slate-400 py-0.5 border-b border-slate-800/60">
              <span>Key Type (`kty`):</span>
              <span className="font-mono text-emerald-400">EC (Elliptic Curve)</span>
            </div>
            <div className="flex justify-between text-slate-400 py-0.5 border-b border-slate-800/60">
              <span>Named Curve (`crv`):</span>
              <span className="font-mono text-emerald-400">P-256 (secp256r1)</span>
            </div>
            <div className="flex justify-between text-slate-400 py-0.5 border-b border-slate-800/60">
              <span>Permitted Operations:</span>
              <span className="font-mono text-emerald-400">["verify"]</span>
            </div>
            <div className="flex justify-between text-slate-400 py-0.5">
              <span>Private Key Exportability:</span>
              <span className="font-mono text-rose-400">Disabled (Non-Extractable)</span>
            </div>
          </div>

          <pre className="p-4 bg-slate-950/90 border border-slate-800/90 rounded-xl text-xs font-mono text-emerald-300/90 overflow-x-auto select-all leading-relaxed shadow-inner">
            {ecdsaFormatted}
          </pre>
        </div>

        {/* ECDH Key Agreement JWK */}
        <div className="glass-panel p-6 rounded-2xl space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="p-2 bg-cyan-500/10 border border-cyan-500/20 rounded-lg text-cyan-400">
                <Key className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-white">ECDH P-256 Public JWK</h3>
                <span className="text-[11px] text-slate-400">Ephemeral Diffie-Hellman Key Agreement</span>
              </div>
            </div>
            <button
              onClick={() => handleCopy(ecdhFormatted, 'ecdh', 'ECDH Public JWK')}
              className="btn-secondary text-xs py-1 px-2.5 flex items-center gap-1"
            >
              {copiedKey === 'ecdh' ? (
                <Check className="w-3.5 h-3.5 text-cyan-400" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
              <span>Copy</span>
            </button>
          </div>

          <div className="space-y-1 text-xs">
            <div className="flex justify-between text-slate-400 py-0.5 border-b border-slate-800/60">
              <span>Key Type (`kty`):</span>
              <span className="font-mono text-cyan-400">EC (Elliptic Curve)</span>
            </div>
            <div className="flex justify-between text-slate-400 py-0.5 border-b border-slate-800/60">
              <span>Named Curve (`crv`):</span>
              <span className="font-mono text-cyan-400">P-256 (secp256r1)</span>
            </div>
            <div className="flex justify-between text-slate-400 py-0.5 border-b border-slate-800/60">
              <span>Key Derivation Purpose:</span>
              <span className="font-mono text-cyan-400">P2P Shared Secret Derivation</span>
            </div>
            <div className="flex justify-between text-slate-400 py-0.5">
              <span>Private Key Exportability:</span>
              <span className="font-mono text-rose-400">Disabled (Non-Extractable)</span>
            </div>
          </div>

          <pre className="p-4 bg-slate-950/90 border border-slate-800/90 rounded-xl text-xs font-mono text-cyan-300/90 overflow-x-auto select-all leading-relaxed shadow-inner">
            {ecdhFormatted}
          </pre>
        </div>
      </div>
    </div>
  );
}
