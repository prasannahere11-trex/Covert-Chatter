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
    success: <CheckCircle2 className="w-4 h-4 text-[#8fe3a0] shrink-0" />,
    warning: <AlertTriangle className="w-4 h-4 text-[#ffcf6b] shrink-0" />,
    error: <XCircle className="w-4 h-4 text-rose-400 shrink-0" />,
    info: <Info className="w-4 h-4 text-[#8fe3a0] shrink-0" />
  };

  const borders = {
    success: 'border-[#8fe3a0] bg-[#111c14] text-[#e2f5e7] shadow-[0_4px_20px_rgba(143,227,160,0.15)]',
    warning: 'border-[#ffcf6b]/70 bg-[#111c14] text-[#e2f5e7] shadow-lg',
    error: 'border-rose-400/70 bg-[#111c14] text-[#e2f5e7] shadow-lg',
    info: 'border-[#24392b] bg-[#111c14] text-[#e2f5e7] shadow-lg'
  };

  return (
    <div
      className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-2xl border text-xs sm:text-sm transition-all duration-200 animate-slide-up max-w-md ${borders[type] || borders.info}`}
      role="alert"
    >
      {icons[type] || icons.info}
      <p className="text-[#e2f5e7] font-medium leading-snug flex-1 font-mono">{message}</p>
      <button
        onClick={onClose}
        className="text-[#5c9a6b] hover:text-white transition-colors p-1 rounded-lg hover:bg-[#18281e]"
        aria-label="Dismiss toast"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
