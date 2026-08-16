import React, { useState, useEffect } from 'react';
import { 
  Shield, 
  QrCode, 
  Scan, 
  KeyRound, 
  Radio, 
  AlertTriangle,
  RefreshCw,
  Fingerprint,
  Lock
} from 'lucide-react';
import MyIdentity from './components/MyIdentity';
import QRScanner from './components/QRScanner';
import KeyDetails from './components/KeyDetails';
import ConnectRoom from './components/ConnectRoom';
import Toast from './components/Toast';
import { getOrCreateIdentity, resetIdentity } from './utils/db';

export default function App() {
  const [activeTab, setActiveTab] = useState('connect'); // 'connect' | 'my-identity' | 'scan-peer' | 'key-details'
  const [identity, setIdentity] = useState(null);
  const [verifiedPeer, setVerifiedPeer] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [fatalError, setFatalError] = useState(null);
  const [toast, setToast] = useState(null);

  const showToast = (message, type = 'success', duration = 3500) => {
    setToast({ message, type, duration, id: Date.now() });
  };

  const loadIdentity = async () => {
    try {
      setIsLoading(true);
      setFatalError(null);
      const res = await getOrCreateIdentity();
      setIdentity(res.identity);
      if (res.isNew) {
        showToast('Fresh cryptographic identity generated & saved', 'success');
      }
    } catch (err) {
      console.error('[App] Identity initialization error:', err);
      setFatalError(
        err.message ||
        "Your browser doesn't support secure key storage — please use a recent version of Chrome, Firefox, or Edge."
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleRegenerateIdentity = async () => {
    try {
      const newIdentity = await resetIdentity();
      setIdentity(newIdentity);
      setVerifiedPeer(null);
      return newIdentity;
    } catch (err) {
      console.error('[App] Failed to regenerate identity:', err);
      throw err;
    }
  };

  useEffect(() => {
    loadIdentity();
  }, []);

  return (
    <div className="min-h-screen flex flex-col text-slate-100 selection:bg-emerald-500/30 selection:text-emerald-200">
      {/* Toast Notification Container */}
      {toast && (
        <Toast
          key={toast.id}
          message={toast.message}
          type={toast.type}
          duration={toast.duration}
          onClose={() => setToast(null)}
        />
      )}

      {/* Top Header Navigation */}
      <header className="glass-nav sticky top-0 z-40 px-4 sm:px-8 py-3.5 border-b border-slate-800/80">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3">
          {/* Logo & Subtitle */}
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-400 to-cyan-500 flex items-center justify-center shadow-lg shadow-emerald-500/20 text-slate-950 font-black">
              <Shield className="w-5 h-5 text-slate-950" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-extrabold tracking-tight text-white">
                  WHISPER <span className="text-emerald-400 font-normal">DROP</span>
                </h1>
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                  PASS 3: E2EE ACTIVE
                </span>
              </div>
              <p className="text-[11px] text-slate-400">
                End-to-End Encrypted WebRTC DataChannel & Non-Extractable Keystore
              </p>
            </div>
          </div>

          {/* Identity Quick Status Pill */}
          {identity && !fatalError && (
            <div className="flex items-center gap-2 bg-slate-900/80 border border-slate-800 px-3 py-1.5 rounded-full text-xs text-slate-300">
              <Fingerprint className="w-3.5 h-3.5 text-emerald-400" />
              <span className="text-slate-400">My ID:</span>
              <span className="font-mono text-emerald-300 font-semibold truncate max-w-[120px] sm:max-w-[160px]">
                {identity.fingerprint.slice(0, 9)}...
              </span>
              {verifiedPeer && (
                <>
                  <span className="text-slate-600">|</span>
                  <Lock className="w-3 h-3 text-cyan-400" />
                  <span className="text-slate-400">Peer:</span>
                  <span className="font-mono text-cyan-300 font-semibold truncate max-w-[100px] sm:max-w-[130px]">
                    {verifiedPeer.fingerprint.slice(0, 9)}...
                  </span>
                </>
              )}
            </div>
          )}
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-8 py-8 space-y-6">
        {/* Fatal Error State: Browser Incompatibility */}
        {fatalError ? (
          <div className="glass-panel border-rose-500/40 p-8 rounded-2xl space-y-4 text-center max-w-xl mx-auto mt-12 animate-fade-in shadow-2xl shadow-rose-950/40">
            <div className="w-16 h-16 rounded-2xl bg-rose-500/10 border border-rose-500/30 flex items-center justify-center text-rose-400 mx-auto">
              <AlertTriangle className="w-8 h-8" />
            </div>
            <h2 className="text-xl font-bold text-white">Secure Storage Unavailable</h2>
            <p className="text-sm text-slate-300 leading-relaxed">{fatalError}</p>
            <div className="pt-2">
              <button
                onClick={loadIdentity}
                className="btn-primary text-xs py-2 px-4 inline-flex items-center gap-2"
              >
                <RefreshCw className="w-4 h-4" />
                <span>Retry Connection</span>
              </button>
            </div>
          </div>
        ) : isLoading ? (
          /* Loading State */
          <div className="glass-panel p-12 rounded-2xl text-center max-w-md mx-auto my-12 space-y-4 animate-pulse">
            <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 mx-auto">
              <RefreshCw className="w-6 h-6 animate-spin" />
            </div>
            <h3 className="text-base font-semibold text-slate-200">Initializing Cryptographic Keystore</h3>
            <p className="text-xs text-slate-400">Loading non-extractable P-256 keypairs from IndexedDB...</p>
          </div>
        ) : (
          <>
            {/* Tab Navigation */}
            <div className="flex items-center justify-center">
              <nav
                className="inline-flex p-1 bg-slate-900/90 border border-slate-800 rounded-2xl shadow-lg backdrop-blur-md overflow-x-auto max-w-full"
                aria-label="Navigation Tabs"
              >
                <button
                  onClick={() => setActiveTab('connect')}
                  className={`flex items-center gap-2 px-3.5 sm:px-5 py-2.5 rounded-xl text-xs sm:text-sm font-semibold transition-all duration-200 ${
                    activeTab === 'connect'
                      ? 'bg-gradient-to-r from-emerald-500 to-emerald-600 text-white shadow-md shadow-emerald-950/50'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                  }`}
                >
                  <Radio className="w-4 h-4" />
                  <span>Connect</span>
                </button>

                <button
                  onClick={() => setActiveTab('my-identity')}
                  className={`flex items-center gap-2 px-3.5 sm:px-5 py-2.5 rounded-xl text-xs sm:text-sm font-semibold transition-all duration-200 ${
                    activeTab === 'my-identity'
                      ? 'bg-gradient-to-r from-emerald-500 to-emerald-600 text-white shadow-md shadow-emerald-950/50'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                  }`}
                >
                  <QrCode className="w-4 h-4" />
                  <span>My Identity</span>
                </button>

                <button
                  onClick={() => setActiveTab('scan-peer')}
                  className={`flex items-center gap-2 px-3.5 sm:px-5 py-2.5 rounded-xl text-xs sm:text-sm font-semibold transition-all duration-200 ${
                    activeTab === 'scan-peer'
                      ? 'bg-gradient-to-r from-cyan-500 to-cyan-600 text-white shadow-md shadow-cyan-950/50'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                  }`}
                >
                  <Scan className="w-4 h-4" />
                  <span>Scan Peer</span>
                  {verifiedPeer && (
                    <span className="w-2 h-2 rounded-full bg-emerald-400 inline-block ml-0.5" />
                  )}
                </button>

                <button
                  onClick={() => setActiveTab('key-details')}
                  className={`flex items-center gap-2 px-3.5 sm:px-5 py-2.5 rounded-xl text-xs sm:text-sm font-semibold transition-all duration-200 ${
                    activeTab === 'key-details'
                      ? 'bg-slate-800 text-emerald-400 border border-slate-700 shadow-md'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                  }`}
                >
                  <KeyRound className="w-4 h-4" />
                  <span>Key Details</span>
                </button>
              </nav>
            </div>

            {/* Active Tab View */}
            <div className="mt-6">
              {activeTab === 'connect' && (
                <ConnectRoom
                  myIdentity={identity}
                  verifiedPeer={verifiedPeer}
                  onSetVerifiedPeer={setVerifiedPeer}
                  onNavigateToScan={() => setActiveTab('scan-peer')}
                  onShowToast={showToast}
                />
              )}

              {activeTab === 'my-identity' && (
                <MyIdentity
                  identity={identity}
                  onRegenerate={handleRegenerateIdentity}
                  onShowToast={showToast}
                />
              )}

              {activeTab === 'scan-peer' && (
                <QRScanner
                  onShowToast={showToast}
                  onPeerVerified={(peer) => setVerifiedPeer(peer)}
                  onNavigateToConnect={() => setActiveTab('connect')}
                />
              )}

              {activeTab === 'key-details' && (
                <KeyDetails identity={identity} onShowToast={showToast} />
              )}
            </div>
          </>
        )}
      </main>

      {/* Footer Note */}
      <footer className="py-6 text-center text-xs text-slate-400 border-t border-slate-900">
        <p>
          Whisper Drop • End-to-End Encrypted (AES-256-GCM) • ECDSA Digital Signatures • Non-Extractable Web Crypto Keystore
        </p>
      </footer>
    </div>
  );
}
