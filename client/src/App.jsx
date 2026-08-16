import React, { useState, useEffect } from 'react';
import { 
  Shield, 
  QrCode, 
  KeyRound, 
  AlertTriangle,
  RefreshCw,
  Fingerprint,
  Lock,
  MessageSquare
} from 'lucide-react';
import MyIdentity from './components/MyIdentity';
import KeyDetails from './components/KeyDetails';
import ConnectRoom from './components/ConnectRoom';
import Toast from './components/Toast';
import { getOrCreateIdentity, resetIdentity } from './utils/db';

export default function App() {
  const [activeTab, setActiveTab] = useState('connect'); // 'connect' | 'my-identity' | 'key-details'
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
    <div className="min-h-screen flex flex-col bg-offwhite text-slate-800 selection:bg-sage-100 selection:text-sage-700">
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
      <header className="glass-nav sticky top-0 z-40 px-4 sm:px-8 py-3.5">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3">
          {/* Logo & Subtitle */}
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-sage-50 border border-sage-200 flex items-center justify-center text-sage-600">
              <Shield className="w-4.5 h-4.5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-base font-bold tracking-tight text-slate-900">
                  Covert Chatter
                </h1>
                <span className="badge-sage text-[10px] py-0.5 px-2">
                  Encrypted
                </span>
              </div>
              <p className="text-[11px] text-slate-500">
                Zero-Knowledge Ephemeral P2P Messenger
              </p>
            </div>
          </div>

          {/* Identity Quick Status */}
          {identity && !fatalError && (
            <div className="flex items-center gap-2 bg-slate-100 border border-slate-200 px-3 py-1.5 rounded-full text-xs text-slate-600">
              <Fingerprint className="w-3.5 h-3.5 text-sage-600" />
              <span className="text-slate-500">My ID:</span>
              <span className="font-mono text-slate-800 font-semibold truncate max-w-[120px] sm:max-w-[160px]">
                {identity.fingerprint.slice(0, 9)}...
              </span>
              {verifiedPeer && (
                <>
                  <span className="text-slate-300">|</span>
                  <Lock className="w-3 h-3 text-sage-600" />
                  <span className="text-slate-500">Peer:</span>
                  <span className="font-mono text-slate-800 font-semibold truncate max-w-[100px] sm:max-w-[130px]">
                    {verifiedPeer.fingerprint.slice(0, 9)}...
                  </span>
                </>
              )}
            </div>
          )}
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-8 py-6 space-y-6">
        {/* Fatal Error State: Browser Incompatibility */}
        {fatalError ? (
          <div className="glass-panel p-8 rounded-2xl space-y-4 text-center max-w-xl mx-auto mt-12 animate-fade-in border-rose-200 bg-white">
            <div className="w-12 h-12 rounded-xl bg-rose-50 border border-rose-200 flex items-center justify-center text-rose-600 mx-auto">
              <AlertTriangle className="w-6 h-6" />
            </div>
            <h2 className="text-lg font-bold text-slate-900">Secure Storage Unavailable</h2>
            <p className="text-sm text-slate-600 leading-relaxed">{fatalError}</p>
            <div className="pt-2">
              <button
                onClick={loadIdentity}
                className="btn-primary text-xs py-2 px-4 inline-flex items-center gap-2"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Retry Connection</span>
              </button>
            </div>
          </div>
        ) : isLoading ? (
          /* Loading State */
          <div className="glass-panel p-12 rounded-2xl text-center max-w-md mx-auto my-12 space-y-3 animate-pulse bg-white">
            <div className="w-10 h-10 rounded-xl bg-sage-50 border border-sage-200 flex items-center justify-center text-sage-600 mx-auto">
              <RefreshCw className="w-5 h-5 animate-spin" />
            </div>
            <h3 className="text-sm font-semibold text-slate-800">Initializing Keystore</h3>
            <p className="text-xs text-slate-500">Loading non-extractable cryptographic keypairs...</p>
          </div>
        ) : (
          <>
            {/* Streamlined Segmented Control Navigation */}
            <div className="flex items-center justify-center">
              <nav
                className="inline-flex p-1 bg-slate-100 border border-slate-200 rounded-xl max-w-full"
                aria-label="Navigation Tabs"
              >
                <button
                  onClick={() => setActiveTab('connect')}
                  className={`flex items-center gap-1.5 px-4 sm:px-5 py-2 rounded-lg text-xs sm:text-sm font-medium transition-all duration-150 ${
                    activeTab === 'connect'
                      ? 'bg-white text-slate-900 shadow-sm font-semibold'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <MessageSquare className="w-3.5 h-3.5" />
                  <span>Chat & Pair</span>
                </button>

                <button
                  onClick={() => setActiveTab('my-identity')}
                  className={`flex items-center gap-1.5 px-3.5 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-medium transition-all duration-150 ${
                    activeTab === 'my-identity'
                      ? 'bg-white text-slate-900 shadow-sm font-semibold'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <QrCode className="w-3.5 h-3.5" />
                  <span>My Identity</span>
                </button>

                <button
                  onClick={() => setActiveTab('key-details')}
                  className={`flex items-center gap-1.5 px-3.5 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-medium transition-all duration-150 ${
                    activeTab === 'key-details'
                      ? 'bg-white text-slate-900 shadow-sm font-semibold'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  <KeyRound className="w-3.5 h-3.5" />
                  <span>Key Details</span>
                </button>
              </nav>
            </div>

            {/* Active Tab View */}
            <div>
              {activeTab === 'connect' && (
                <ConnectRoom
                  myIdentity={identity}
                  verifiedPeer={verifiedPeer}
                  onSetVerifiedPeer={setVerifiedPeer}
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

              {activeTab === 'key-details' && (
                <KeyDetails identity={identity} onShowToast={showToast} />
              )}
            </div>
          </>
        )}
      </main>

      {/* Footer Note */}
      <footer className="py-6 text-center text-xs text-slate-400 border-t border-slate-200 mt-auto">
        <p>
          Covert Chatter • End-to-End Encrypted (AES-256-GCM) • Ephemeral Volatile Memory
        </p>
      </footer>
    </div>
  );
}
