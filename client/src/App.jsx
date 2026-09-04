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
    <div className="min-h-screen flex flex-col items-center justify-center p-3 sm:p-6 bg-[#0b120e] text-[#e2f5e7] selection:bg-[#8fe3a0] selection:text-[#0b120e] relative overflow-x-hidden">
      {/* Subtle CRT scanline overlay */}
      <div className="scanlines-overlay" />

      {/* Ambient background depth */}
      <div 
        className="fixed inset-0 z-0 pointer-events-none"
        style={{
          background: 'radial-gradient(ellipse 70% 60% at 50% 30%, rgba(143, 227, 160, 0.04) 0%, rgba(11, 18, 14, 0.95) 75%, #070c09 100%)'
        }}
      />

      {/* Toast Notification */}
      {toast && (
        <Toast
          key={toast.id}
          message={toast.message}
          type={toast.type}
          duration={toast.duration}
          onClose={() => setToast(null)}
        />
      )}

      {/* Main Terminal Frame with Soft Corners */}
      <div className="covert-frame w-full max-w-4xl relative z-10 animate-fade-in my-auto">
        {/* Top Status Bar */}
        <div className="statusbar">
          <div className="brand">
            <div className="brand-icon">◆</div>
            <span>COVERT CHATTER</span>
          </div>

          <div className="flex items-center gap-3">
            {identity && !fatalError && (
              <span className="hidden sm:inline font-mono text-[10px] text-[#5c9a6b]">
                ID: {identity.fingerprint.slice(0, 8)}...
              </span>
            )}
            <div className="pill-encrypted">
              <span className="dot" />
              <span>{verifiedPeer ? 'CONNECTED' : 'ENCRYPTED'}</span>
            </div>
          </div>
        </div>

        {/* Tab Switcher */}
        <div className="tabs-header">
          <nav className="tabs-wrap" aria-label="Navigation Tabs">
            <button
              onClick={() => setActiveTab('connect')}
              className={`tab-btn ${activeTab === 'connect' ? 'active' : ''}`}
            >
              <MessageSquare className="w-3.5 h-3.5" />
              <span>💬 CHAT &amp; PAIR</span>
            </button>

            <button
              onClick={() => setActiveTab('my-identity')}
              className={`tab-btn ${activeTab === 'my-identity' ? 'active' : ''}`}
            >
              <QrCode className="w-3.5 h-3.5" />
              <span>▦ MY IDENTITY</span>
            </button>
          </nav>
        </div>

        {/* Main Tab Content */}
        <div className="p-4 sm:p-6">
          {fatalError ? (
            <div className="p-8 rounded-2xl space-y-4 text-center max-w-xl mx-auto my-4 bg-[#18281e] border border-rose-500/40 shadow-xl animate-fade-in">
              <div className="w-12 h-12 rounded-xl bg-rose-500/15 border border-rose-500/40 flex items-center justify-center text-rose-400 mx-auto">
                <AlertTriangle className="w-6 h-6" />
              </div>
              <h2 className="text-base font-bold text-white">Secure Storage Unavailable</h2>
              <p className="text-xs text-[#7fa889] leading-relaxed">{fatalError}</p>
              <div className="pt-2">
                <button
                  onClick={loadIdentity}
                  className="btn btn-primary text-xs py-2 px-4 inline-flex items-center gap-2"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Retry Connection</span>
                </button>
              </div>
            </div>
          ) : isLoading ? (
            <div className="p-12 rounded-2xl text-center max-w-md mx-auto my-8 space-y-3 bg-[#111c14] border border-[#24392b] animate-pulse">
              <div className="w-10 h-10 rounded-xl bg-[#0b120e] border border-[#8fe3a0] flex items-center justify-center text-[#8fe3a0] mx-auto shadow-[0_0_12px_rgba(143,227,160,0.2)]">
                <RefreshCw className="w-5 h-5 animate-spin" />
              </div>
              <h3 className="text-xs font-bold text-white font-mono uppercase tracking-wider">Initializing Keystore</h3>
              <p className="text-xs text-[#5c9a6b]">Loading cryptographic keypairs in volatile memory...</p>
            </div>
          ) : (
            <div className="relative">
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
          )}
        </div>

        {/* Frame Footer */}
        <div className="frame-footer">
          <div>
            <span>COVERT CHATTER</span>
            <span className="sep">·</span>
            <span>AES-256-GCM E2E</span>
            <span className="sep">·</span>
            <span>EPHEMERAL MEMORY</span>
            <span className="term-cursor" />
          </div>

          <button
            type="button"
            onClick={() => setShowKeyDetailsModal(true)}
            className="lock-btn"
            title="View cryptographic key details and security architecture"
          >
            <Lock className="w-3 h-3 text-[#ffcf6b]" />
            <span>SECURITY DETAILS</span>
          </button>
        </div>
      </div>

      {/* Key Details Modal Overlay */}
      {showKeyDetailsModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/80 backdrop-blur-md animate-fade-in"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setShowKeyDetailsModal(false);
            }
          }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="key-details-title"
        >
          <div className="bg-[#131f17] rounded-2xl border border-[#24392b] shadow-2xl max-w-3xl w-full max-h-[90vh] flex flex-col overflow-hidden animate-scale-up">
            {/* Modal Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-[#24392b] bg-[#0e1811]">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-[#0b120e] border border-[#8fe3a0] rounded-xl text-[#8fe3a0] shadow-[0_0_10px_rgba(143,227,160,0.2)]">
                  <Lock className="w-4 h-4" />
                </div>
                <div>
                  <h3 id="key-details-title" className="text-sm font-bold text-white font-mono">
                    Security &amp; Key Details
                  </h3>
                  <p className="text-[11px] text-[#5c9a6b]">
                    Cryptographic identities and sandboxed keystore architecture
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowKeyDetailsModal(false)}
                className="p-1.5 text-[#5c9a6b] hover:text-[#8fe3a0] hover:bg-[#18281e] rounded-lg transition-colors"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Modal Scrollable Content */}
            <div className="overflow-y-auto p-4 sm:p-6 space-y-4 bg-[#0b120e]">
              <KeyDetails identity={identity} onShowToast={showToast} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
