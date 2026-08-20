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
    success: <CheckCircle2 className="w-4 h-4 text-[#5DD62C] shrink-0" />,
    warning: <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />,
    error: <XCircle className="w-4 h-4 text-rose-400 shrink-0" />,
    info: <Info className="w-4 h-4 text-[#5DD62C] shrink-0" />
  };

  const borders = {
    success: 'border-[#5DD62C] bg-[#202020] text-white shadow-[0_0_15px_rgba(93,214,44,0.25)]',
    warning: 'border-amber-400/60 bg-[#202020] text-white shadow-lg',
    error: 'border-rose-400/60 bg-[#202020] text-white shadow-lg',
    info: 'border-[#337418]/60 bg-[#202020] text-white shadow-lg'
  };

  return (
    <div
      className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-2xl border text-xs sm:text-sm transition-all duration-200 animate-slide-up max-w-md ${borders[type] || borders.info}`}
      role="alert"
    >
      {icons[type] || icons.info}
      <p className="text-white font-medium leading-snug flex-1">{message}</p>
      <button
        onClick={onClose}
        className="text-slate-400 hover:text-white transition-colors p-1 rounded-lg hover:bg-[#282828]"
        aria-label="Dismiss toast"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
