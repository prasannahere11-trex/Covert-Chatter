import React, { useState, useEffect } from 'react';
import { 
  Shield, 
  QrCode, 
  AlertTriangle,
  RefreshCw,
  Fingerprint,
  Lock,
  MessageSquare,
  X
} from 'lucide-react';
import MyIdentity from './components/MyIdentity';
import KeyDetails from './components/KeyDetails';
import ConnectRoom from './components/ConnectRoom';
import Toast from './components/Toast';
import { getOrCreateIdentity, resetIdentity } from './utils/db';

export default function App() {
  const [activeTab, setActiveTab] = useState('connect'); // 'connect' | 'my-identity'
  const [showKeyDetailsModal, setShowKeyDetailsModal] = useState(false);
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

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        setShowKeyDetailsModal(false);
      }
    };
    if (showKeyDetailsModal) {
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showKeyDetailsModal]);

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

      {/* Top Header Navigation — Thin, unobtrusive branded header bar */}
      <header className="glass-nav sticky top-0 z-40 px-4 sm:px-6 py-2.5">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-3">
          {/* Circular Shield Logo & App Name */}
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-sage-50 border border-sage-200/90 flex items-center justify-center text-sage-600 shadow-xs">
              <Shield className="w-4 h-4" />
            </div>
            <span className="text-sm sm:text-base font-bold tracking-tight text-slate-900">
              Covert Chatter
            </span>
          </div>

          {/* Connection Status Pill Badge */}
          <div className="flex items-center gap-2">
            {identity && !fatalError && (
              <div className="hidden md:flex items-center gap-1.5 text-[11px] text-slate-400 mr-1 font-mono">
                <span>ID: {identity.fingerprint.slice(0, 6)}...</span>
              </div>
            )}
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium bg-sage-50 text-sage-700 border border-sage-200">
              <span className="w-1.5 h-1.5 rounded-full bg-sage-500 animate-pulse" />
              <span>{verifiedPeer ? 'Connected' : 'Encrypted'}</span>
            </span>
          </div>
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
            </div>
          </>
        )}
      </main>

      {/* Footer Area with Tagline and Subtle Security Details Link */}
      <footer className="py-6 text-center text-xs text-slate-400 border-t border-slate-200 mt-auto px-4">
        <div className="flex flex-col sm:flex-row items-center justify-center gap-1.5 sm:gap-3">
          <p>
            Covert Chatter • End-to-End Encrypted (AES-256-GCM) • Ephemeral Volatile Memory
          </p>
          <span className="hidden sm:inline text-slate-300">•</span>
          <button
            type="button"
            onClick={() => setShowKeyDetailsModal(true)}
            className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 transition-colors py-1.5 px-2.5 rounded hover:bg-slate-100 touch-manipulation focus:outline-none focus-visible:ring-1 focus-visible:ring-sage-400"
            title="View cryptographic key details and security architecture"
          >
            <Lock className="w-3 h-3 text-slate-400" />
            <span>Security details</span>
          </button>
        </div>
      </footer>

      {/* Key Details Modal Overlay */}
      {showKeyDetailsModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-slate-900/60 backdrop-blur-sm animate-fade-in"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setShowKeyDetailsModal(false);
            }
          }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="key-details-title"
        >
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl max-w-3xl w-full max-h-[90vh] flex flex-col overflow-hidden animate-scale-in">
            {/* Modal Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 bg-slate-50/50">
              <div className="flex items-center gap-2">
                <div className="p-1.5 bg-sage-50 border border-sage-200 rounded-lg text-sage-600">
                  <Lock className="w-4 h-4" />
                </div>
                <div>
                  <h3 id="key-details-title" className="text-sm font-bold text-slate-900">
                    Security & Key Details
                  </h3>
                  <p className="text-[11px] text-slate-500">
                    Cryptographic identities and sandboxed keystore architecture
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowKeyDetailsModal(false)}
                className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Scrollable Content */}
            <div className="overflow-y-auto p-4 sm:p-6 space-y-4">
              <KeyDetails identity={identity} onShowToast={showToast} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
