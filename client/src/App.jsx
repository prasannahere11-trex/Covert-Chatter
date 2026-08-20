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
import PixelBlast from './components/PixelBlast/PixelBlast';
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
    <div className="min-h-screen flex flex-col bg-[#121212] text-white selection:bg-[#D4FF27] selection:text-[#121212] relative overflow-x-hidden">
      {/* Animated Neon Green PixelBlast Background */}
      <div className="fixed inset-0 z-0 pointer-events-none opacity-35 overflow-hidden">
        <PixelBlast
          variant="square"
          pixelSize={4}
          color="#D4FF27"
          patternScale={2.5}
          patternDensity={0.7}
          pixelSizeJitter={0.2}
          enableRipples={false}
          speed={0.35}
          edgeFade={0.15}
          transparent={true}
        />
      </div>

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

      {/* Top Header Navigation — Charcoal with thin Olive Shadow accent border */}
      <header className="glass-nav sticky top-0 z-40 px-4 sm:px-6 py-3 border-b border-[#A8CC19]/40 bg-[#1C1C1C]/95">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-3">
          {/* Circular Shield Logo & App Name */}
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-[#121212] border border-[#D4FF27] flex items-center justify-center text-[#D4FF27] shadow-[0_0_10px_rgba(212,255,39,0.25)]">
              <Shield className="w-4 h-4" />
            </div>
            <span className="text-sm sm:text-base font-bold tracking-tight text-white">
              Covert Chatter
            </span>
          </div>

          {/* Connection Status Pill Badge with Neon Glow */}
          <div className="flex items-center gap-2">
            {identity && !fatalError && (
              <div className="hidden md:flex items-center gap-1.5 text-[11px] text-[#9E9E9E] mr-1 font-mono">
                <span>ID: {identity.fingerprint.slice(0, 6)}...</span>
              </div>
            )}
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11px] font-bold bg-[#1C1C1C] text-[#D4FF27] border border-[#D4FF27] shadow-[0_0_12px_rgba(212,255,39,0.25)]">
              <span className="w-1.5 h-1.5 rounded-full bg-[#D4FF27] animate-pulse" />
              <span>{verifiedPeer ? 'Connected' : 'Encrypted'}</span>
            </span>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-8 py-6 space-y-6 relative z-10">
        {/* Fatal Error State: Browser Incompatibility */}
        {fatalError ? (
          <div className="glass-panel p-8 rounded-2xl space-y-4 text-center max-w-xl mx-auto mt-12 animate-fade-in border-rose-500/50 bg-[#1C1C1C]">
            <div className="w-12 h-12 rounded-xl bg-rose-500/15 border border-rose-500/40 flex items-center justify-center text-rose-500 mx-auto">
              <AlertTriangle className="w-6 h-6" />
            </div>
            <h2 className="text-lg font-bold text-white">Secure Storage Unavailable</h2>
            <p className="text-sm text-slate-300 leading-relaxed">{fatalError}</p>
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
          <div className="glass-panel p-12 rounded-2xl text-center max-w-md mx-auto my-12 space-y-3 animate-pulse bg-[#1C1C1C] border-[#A8CC19]/30">
            <div className="w-10 h-10 rounded-xl bg-[#121212] border border-[#D4FF27] flex items-center justify-center text-[#D4FF27] mx-auto shadow-[0_0_12px_rgba(212,255,39,0.25)]">
              <RefreshCw className="w-5 h-5 animate-spin" />
            </div>
            <h3 className="text-sm font-semibold text-white">Initializing Keystore</h3>
            <p className="text-xs text-slate-400">Loading non-extractable cryptographic keypairs...</p>
          </div>
        ) : (
          <>
            {/* Streamlined Segmented Control Navigation */}
            <div className="flex items-center justify-center">
              <nav
                className="inline-flex p-1.5 bg-[#1C1C1C] border border-[#A8CC19]/40 rounded-2xl max-w-full shadow-lg"
                aria-label="Navigation Tabs"
              >
                <button
                  onClick={() => setActiveTab('connect')}
                  className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs sm:text-sm font-bold transition-all duration-200 ${
                    activeTab === 'connect'
                      ? 'bg-[#D4FF27] text-[#121212] shadow-[0_0_14px_rgba(212,255,39,0.35)]'
                      : 'text-slate-300 hover:text-white hover:bg-[#242424]'
                  }`}
                >
                  <MessageSquare className="w-4 h-4" />
                  <span>Chat & Pair</span>
                </button>

                <button
                  onClick={() => setActiveTab('my-identity')}
                  className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs sm:text-sm font-bold transition-all duration-200 ${
                    activeTab === 'my-identity'
                      ? 'bg-[#D4FF27] text-[#121212] shadow-[0_0_14px_rgba(212,255,39,0.35)]'
                      : 'text-slate-300 hover:text-white hover:bg-[#242424]'
                  }`}
                >
                  <QrCode className="w-4 h-4" />
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
      <footer className="py-6 text-center text-xs text-slate-400 border-t border-[#A8CC19]/25 mt-auto px-4 bg-[#121212]">
        <div className="flex flex-col sm:flex-row items-center justify-center gap-1.5 sm:gap-3">
          <p>
            Covert Chatter • End-to-End Encrypted (AES-256-GCM) • Ephemeral Volatile Memory
          </p>
          <span className="hidden sm:inline text-slate-600">•</span>
          <button
            type="button"
            onClick={() => setShowKeyDetailsModal(true)}
            className="inline-flex items-center gap-1.5 text-xs text-[#A8CC19] hover:text-[#D4FF27] transition-colors py-1.5 px-3 rounded-lg hover:bg-[#1C1C1C] touch-manipulation focus:outline-none focus-visible:ring-1 focus-visible:ring-[#D4FF27]"
            title="View cryptographic key details and security architecture"
          >
            <Lock className="w-3 h-3 text-[#A8CC19]" />
            <span>Security details</span>
          </button>
        </div>
      </footer>

      {/* Key Details Modal Overlay */}
      {showKeyDetailsModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/85 backdrop-blur-md animate-fade-in"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setShowKeyDetailsModal(false);
            }
          }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="key-details-title"
        >
          <div className="bg-[#1C1C1C] rounded-2xl border border-[#A8CC19]/50 shadow-2xl max-w-3xl w-full max-h-[90vh] flex flex-col overflow-hidden animate-scale-up">
            {/* Modal Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#A8CC19]/30 bg-[#181818]">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-[#121212] border border-[#D4FF27] rounded-xl text-[#D4FF27] shadow-[0_0_10px_rgba(212,255,39,0.2)]">
                  <Lock className="w-4 h-4" />
                </div>
                <div>
                  <h3 id="key-details-title" className="text-sm font-bold text-white">
                    Security & Key Details
                  </h3>
                  <p className="text-[11px] text-slate-400">
                    Cryptographic identities and sandboxed keystore architecture
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowKeyDetailsModal(false)}
                className="p-1.5 text-slate-400 hover:text-white hover:bg-[#242424] rounded-lg transition-colors"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Scrollable Content */}
            <div className="overflow-y-auto p-4 sm:p-6 space-y-4 bg-[#121212]">
              <KeyDetails identity={identity} onShowToast={showToast} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
