import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import fr from './locales/fr.json';
import en from './locales/en.json';

const systemLanguage = navigator.language.split('-')[0];
void i18n.use(initReactI18next).init({
  resources: { fr: { translation: fr }, en: { translation: en } },
  lng: localStorage.getItem('studio.language') ?? systemLanguage,
  fallbackLng: 'en',
  supportedLngs: ['fr', 'en'],
  interpolation: { escapeValue: false },
});
export default i18n;
