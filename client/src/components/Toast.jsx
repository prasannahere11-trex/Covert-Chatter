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
    success: <CheckCircle2 className="w-4 h-4 text-sage-600 shrink-0" />,
    warning: <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0" />,
    error: <XCircle className="w-4 h-4 text-rose-600 shrink-0" />,
    info: <Info className="w-4 h-4 text-slate-500 shrink-0" />
  };

  const borders = {
    success: 'border-sage-200 bg-white shadow-lg',
    warning: 'border-amber-200 bg-white shadow-lg',
    error: 'border-rose-200 bg-white shadow-lg',
    info: 'border-slate-200 bg-white shadow-lg'
  };

  return (
    <div
      className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-xl border shadow-lg text-xs sm:text-sm transition-all duration-200 animate-slide-up max-w-md ${borders[type] || borders.info}`}
      role="alert"
    >
      {icons[type] || icons.info}
      <p className="text-slate-800 font-medium leading-snug flex-1">{message}</p>
      <button
        onClick={onClose}
        className="text-slate-400 hover:text-slate-600 transition-colors p-1 rounded-lg hover:bg-slate-100"
        aria-label="Dismiss toast"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
