import React, { useEffect } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from 'lucide-react';

export default function Toast({ message, type = 'success', onClose, duration = 3500 }) {
  useEffect(() => {
    if (!duration) return;
    const timer = setTimeout(() => {
      onClose();
    }, duration);
    return () => clearTimeout(timer);
  }, [duration, onClose]);

  const icons = {
    success: <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />,
    warning: <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />,
    error: <XCircle className="w-5 h-5 text-rose-400 shrink-0" />,
    info: <Info className="w-5 h-5 text-cyan-400 shrink-0" />
  };

  const borders = {
    success: 'border-emerald-500/30 bg-emerald-950/80 shadow-emerald-500/10',
    warning: 'border-amber-500/30 bg-amber-950/80 shadow-amber-500/10',
    error: 'border-rose-500/30 bg-rose-950/80 shadow-rose-500/10',
    info: 'border-cyan-500/30 bg-cyan-950/80 shadow-cyan-500/10'
  };

  return (
    <div
      className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-xl border backdrop-blur-xl shadow-2xl text-sm transition-all duration-300 animate-slide-up max-w-md ${borders[type] || borders.info}`}
      role="alert"
    >
      {icons[type] || icons.info}
      <p className="text-slate-100 font-medium leading-snug flex-1">{message}</p>
      <button
        onClick={onClose}
        className="text-slate-400 hover:text-slate-200 transition-colors p-1 rounded-lg hover:bg-white/10"
        aria-label="Dismiss toast"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
