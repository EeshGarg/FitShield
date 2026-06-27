/**
 * Shared FitShield display-language list.
 *
 * Used by the Settings language selector and the first-run welcome page so the
 * 80+ language entries live in exactly one place.
 *   - value:    stored locale code ("" = follow the browser).
 *   - labelKey: i18n message key for the translated language name.
 *   - native:   the name in its own script, shown untranslated so users always
 *               recognize their language. ("" entry uses nativeKey instead.)
 */
(function (global) {
  "use strict";

  const OPTIONS = [
    { value: "", labelKey: "languageSystem", nativeKey: "languageSystemSub" },
    { value: "en", labelKey: "languageEnglish", native: "English" },
    { value: "ja", labelKey: "languageJapanese", native: "日本語" },
    { value: "zh_CN", labelKey: "languageChinese", native: "简体中文" },
    { value: "ko", labelKey: "languageKorean", native: "한국어" },
    { value: "hi", labelKey: "languageHindi", native: "हिन्दी" },
    { value: "es_419", labelKey: "languageSpanishLatam", native: "Español (Latinoamérica)" },
    { value: "es", labelKey: "languageSpanishSpain", native: "Español (España)" },
    { value: "fr", labelKey: "languageFrench", native: "Français" },
    { value: "yue", labelKey: "languageCantonese", native: "粵語" },
    { value: "th", labelKey: "languageThai", native: "ไทย" },
    { value: "pa", labelKey: "languagePunjabi", native: "ਪੰਜਾਬੀ" },
    { value: "ta", labelKey: "languageTamil", native: "தமிழ்" },
    { value: "zh_TW", labelKey: "languageChineseTraditionalTaiwan", native: "繁體中文（台灣）" },
    { value: "af", labelKey: "languageAfrikaans", native: "Afrikaans" },
    { value: "sq", labelKey: "languageAlbanian", native: "Shqip" },
    { value: "eu", labelKey: "languageBasque", native: "Euskara" },
    { value: "be", labelKey: "languageBelarusian", native: "Беларуская" },
    { value: "bg", labelKey: "languageBulgarian", native: "Български" },
    { value: "ca", labelKey: "languageCatalan", native: "Català" },
    { value: "hr", labelKey: "languageCroatian", native: "Hrvatski" },
    { value: "cs", labelKey: "languageCzech", native: "Čeština" },
    { value: "da", labelKey: "languageDanish", native: "Dansk" },
    { value: "nl", labelKey: "languageDutch", native: "Nederlands" },
    { value: "et", labelKey: "languageEstonian", native: "Eesti" },
    { value: "fi", labelKey: "languageFinnish", native: "Suomi" },
    { value: "el", labelKey: "languageGreek", native: "Ελληνικά" },
    { value: "hu", labelKey: "languageHungarian", native: "Magyar" },
    { value: "is", labelKey: "languageIcelandic", native: "Íslenska" },
    { value: "ga", labelKey: "languageIrish", native: "Gaeilge" },
    { value: "it", labelKey: "languageItalian", native: "Italiano" },
    { value: "lv", labelKey: "languageLatvian", native: "Latviešu" },
    { value: "lt", labelKey: "languageLithuanian", native: "Lietuvių" },
    { value: "mk", labelKey: "languageMacedonian", native: "Македонски" },
    { value: "mt", labelKey: "languageMaltese", native: "Malti" },
    { value: "no", labelKey: "languageNorwegian", native: "Norsk" },
    { value: "pl", labelKey: "languagePolish", native: "Polski" },
    { value: "pt_PT", labelKey: "languagePortuguesePortugal", native: "Português (Portugal)" },
    { value: "ro", labelKey: "languageRomanian", native: "Română" },
    { value: "ru", labelKey: "languageRussian", native: "Русский" },
    { value: "sr", labelKey: "languageSerbian", native: "Српски" },
    { value: "sk", labelKey: "languageSlovak", native: "Slovenčina" },
    { value: "sl", labelKey: "languageSlovenian", native: "Slovenščina" },
    { value: "sv", labelKey: "languageSwedish", native: "Svenska" },
    { value: "tr", labelKey: "languageTurkish", native: "Türkçe" },
    { value: "uk", labelKey: "languageUkrainian", native: "Українська" },
    { value: "cy", labelKey: "languageWelsh", native: "Cymraeg" },
    { value: "bn", labelKey: "languageBengali", native: "বাংলা" },
    { value: "gu", labelKey: "languageGujarati", native: "ગુજરાતી" },
    { value: "kn", labelKey: "languageKannada", native: "ಕನ್ನಡ" },
    { value: "ml", labelKey: "languageMalayalam", native: "മലയാളം" },
    { value: "mr", labelKey: "languageMarathi", native: "मराठी" },
    { value: "ne", labelKey: "languageNepali", native: "नेपाली" },
    { value: "or", labelKey: "languageOdia", native: "ଓଡ଼ିଆ" },
    { value: "si", labelKey: "languageSinhala", native: "සිංහල" },
    { value: "te", labelKey: "languageTelugu", native: "తెలుగు" },
    { value: "ur", labelKey: "languageUrdu", native: "اردو" },
    { value: "as", labelKey: "languageAssamese", native: "অসমীয়া" },
    { value: "id", labelKey: "languageIndonesian", native: "Bahasa Indonesia" },
    { value: "ms", labelKey: "languageMalay", native: "Bahasa Melayu" },
    { value: "vi", labelKey: "languageVietnamese", native: "Tiếng Việt" },
    { value: "km", labelKey: "languageKhmer", native: "ខ្មែរ" },
    { value: "lo", labelKey: "languageLao", native: "ລາວ" },
    { value: "my", labelKey: "languageBurmese", native: "မြန်မာ" },
    { value: "tl", labelKey: "languageFilipinoTagalog", native: "Filipino / Tagalog" },
    { value: "jv", labelKey: "languageJavanese", native: "Basa Jawa" },
    { value: "su", labelKey: "languageSundanese", native: "Basa Sunda" },
    { value: "ar", labelKey: "languageArabic", native: "العربية" },
    { value: "fa", labelKey: "languagePersian", native: "فارسی" },
    { value: "he", labelKey: "languageHebrew", native: "עברית" },
    { value: "hy", labelKey: "languageArmenian", native: "Հայերեն" },
    { value: "ka", labelKey: "languageGeorgian", native: "ქართული" },
    { value: "kk", labelKey: "languageKazakh", native: "Қазақша" },
    { value: "ky", labelKey: "languageKyrgyz", native: "Кыргызча" },
    { value: "mn", labelKey: "languageMongolian", native: "Монгол" },
    { value: "ps", labelKey: "languagePashto", native: "پښتو" },
    { value: "tg", labelKey: "languageTajik", native: "Тоҷикӣ" },
    { value: "tk", labelKey: "languageTurkmen", native: "Türkmençe" },
    { value: "ug", labelKey: "languageUyghur", native: "ئۇيغۇرچە" },
    { value: "uz", labelKey: "languageUzbek", native: "Oʻzbekcha" },
    { value: "pt_BR", labelKey: "languagePortugueseBrazil", native: "Português (Brasil)" },
    { value: "sw", labelKey: "languageSwahili", native: "Kiswahili" },
    { value: "am", labelKey: "languageAmharic", native: "አማርኛ" }
  ];

  global.FITSHIELD_LANGUAGE_OPTIONS = OPTIONS;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = OPTIONS;
  }
})(typeof self !== "undefined" ? self : globalThis);
