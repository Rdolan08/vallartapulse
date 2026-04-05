import React, { createContext, useContext, useState, ReactNode } from 'react';

type Language = 'en' | 'es';

interface LanguageContextType {
  lang: Language;
  toggleLanguage: () => void;
  t: (en: string, es: string) => string;
}

const STORAGE_KEY = 'vp_lang';

function getInitialLang(): Language {
  // 1. Respect an explicit previous choice
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'es') return 'es';
    if (stored === 'en') return 'en';
  } catch {}
  // 2. Use the browser's language setting (covers Mexican/Spanish visitors)
  try {
    const browserLang = navigator.language || '';
    if (browserLang.toLowerCase().startsWith('es')) return 'es';
  } catch {}
  // 3. Default to English
  return 'en';
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<Language>(getInitialLang);

  const toggleLanguage = () => {
    setLang((prev) => {
      const next = prev === 'en' ? 'es' : 'en';
      try { localStorage.setItem(STORAGE_KEY, next); } catch {}
      return next;
    });
  };

  const t = (en: string, es: string) => {
    return lang === 'es' ? es : en;
  };

  return (
    <LanguageContext.Provider value={{ lang, toggleLanguage, t }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (context === undefined) {
    throw new Error('useLanguage must be used within a LanguageProvider');
  }
  return context;
}
