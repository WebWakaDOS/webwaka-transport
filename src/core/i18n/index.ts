/**
 * WebWaka Transport Suite — Africa-First i18n
 * Languages: English (en), Yorùbá (yo), Igbo (ig), Hausa (ha)
 * Nigeria-First: monetary display in ₦ (kobo → naira)
 */

export type Language = 'en' | 'yo' | 'ig' | 'ha';

const translations: Record<Language, Record<string, string>> = {
  en: {
    // App shell
    app_name: 'WebWaka Transport',
    dashboard: 'Dashboard',
    search_trips: 'Search Trips',
    my_bookings: 'My Bookings',
    agent_pos: 'Agent POS',
    operator: 'Operator',
    // Search form
    origin: 'Origin',
    from: 'From',
    destination: 'Destination',
    to: 'To',
    date: 'Date',
    any_date: 'Any date',
    search: 'Search',
    available_seats: 'Available Seats',
    departure: 'Departure',
    departs: 'Departs',
    arrives: 'Arrives',
    fare: 'Fare',
    book_now: 'Book Now',
    no_trips_found: 'No trips found',
    sold_out: 'Sold Out',
    // Seat selection
    select_seats: 'Select Seats',
    select_your_seat: 'Select your seat',
    window: 'Window',
    aisle: 'Aisle',
    vip_class: 'VIP',
    standard_class: 'Standard',
    // Booking
    passenger_name: 'Passenger Name',
    payment_method: 'Payment Method',
    paystack: 'Paystack',
    flutterwave: 'Flutterwave',
    bank_transfer: 'Bank Transfer',
    confirm_booking: 'Confirm Booking',
    booking_confirmed: 'Booking Confirmed',
    booking_cancelled: 'Booking Cancelled',
    proceed_to_payment: 'Proceed to Payment',
    total_amount: 'Total Amount',
    booking_summary: 'Booking Summary',
    pay_now: 'Pay Now',
    ndpr_consent: 'I consent to the processing of my personal data in accordance with the Nigeria Data Protection Regulation (NDPR)',
    ndpr_required: 'NDPR consent is required to proceed',
    // Ticket & receipt
    your_ticket: 'Your Ticket',
    view_eticket: 'View E-Ticket',
    share_via_whatsapp: 'Share via WhatsApp',
    // Reviews
    rate_your_trip: 'Rate your trip',
    leave_a_review: 'Leave a review',
    review_submitted: 'Review submitted — thank you!',
    review_already_submitted: 'You have already reviewed this trip',
    // Agent POS
    select_trip: 'Select Trip',
    select_seats_pos: 'Select Seats',
    cash: 'Cash',
    mobile_money: 'Mobile Money',
    card: 'Card',
    print_receipt: 'Print Receipt',
    sale_complete: 'Sale Complete',
    offline_queued: 'Saved offline — will sync when connected',
    pending_sync: 'pending sync',
    // Seat status
    available: 'Available',
    reserved: 'Reserved',
    confirmed: 'Confirmed',
    blocked: 'Blocked',
    // Trip states
    scheduled: 'Scheduled',
    boarding: 'Boarding',
    in_transit: 'In Transit',
    completed: 'Completed',
    cancelled: 'Cancelled',
    // Operator
    trips_today: 'Trips Today',
    total_revenue: 'Total Revenue',
    active_agents: 'Active Agents',
    manage_routes: 'Manage Routes',
    manage_vehicles: 'Manage Vehicles',
    // Common
    loading: 'Loading...',
    error: 'Error',
    retry: 'Retry',
    cancel: 'Cancel',
    confirm: 'Confirm',
    back: 'Back',
    save: 'Save',
    done: 'Done',
    success: 'Success',
    online: 'Online',
    offline: 'Offline',
    // Error messages
    seat_no_longer_available: 'This seat is no longer available',
    payment_failed: 'Payment failed. Please try again.',
    session_expired: 'Session expired, please log in again',
    language: 'Language',
  },
  yo: {
    app_name: 'WebWaka Ọkọ',
    dashboard: 'Ibi Iṣakoso',
    search_trips: 'Wa Ìrìnàjò',
    my_bookings: 'Àwọn Ìpàdé Mi',
    agent_pos: 'POS Aṣojú',
    operator: 'Olùṣiṣẹ́',
    origin: 'Ibẹrẹ',
    from: 'Láti',
    destination: 'Ibi Àkọ́kọ́',
    to: 'Sí',
    date: 'Ọjọ́',
    any_date: 'Ọjọ́ Eyíkéyìí',
    search: 'Wá',
    available_seats: 'Àwọn Ìjókòó Tó Wà',
    departure: 'Ìgbà Ìkúrò',
    departs: 'Ó Kúrò',
    arrives: 'Ó Dé',
    fare: 'Owó Ọkọ',
    book_now: 'Ṣe Ìpàdé Báyìí',
    no_trips_found: 'Kò sí ìrìnàjò tí a rí',
    sold_out: 'Ti Tán',
    select_seats: 'Yan Àwọn Ìjókòó',
    select_your_seat: 'Yan Ìjókòó Rẹ',
    window: 'Fèrèsé',
    aisle: 'Ọ̀nà Pàtàkì',
    vip_class: 'VIP',
    standard_class: 'Ìpele Deede',
    passenger_name: 'Orúkọ Arìnkiri',
    payment_method: 'Ọ̀nà Ìsanwó',
    paystack: 'Paystack',
    flutterwave: 'Flutterwave',
    bank_transfer: 'Gbígbé Owo Banki',
    confirm_booking: 'Jẹ́rìísí Ìpàdé',
    booking_confirmed: 'Ìpàdé Ti Jẹ́rìísí',
    booking_cancelled: 'Ìpàdé Ti Fagilé',
    proceed_to_payment: 'Lọ Sí Ìsanwó',
    total_amount: 'Owó Àpapọ̀',
    booking_summary: 'Àkójọpọ̀ Ìpàdé',
    pay_now: 'San Báyìí',
    ndpr_consent: 'Mo gbà láti jẹ́ kí a ṣe àkọsílẹ̀ àwọn data mi gẹ́gẹ́ bí NDPR',
    ndpr_required: 'Àṣẹ NDPR nílò láti tẹ̀síwájú',
    your_ticket: 'Tikẹ́tì Rẹ',
    view_eticket: 'Wo E-Tikẹ́tì',
    share_via_whatsapp: 'Pin Lórí WhatsApp',
    rate_your_trip: 'Ṣe Ìṣírò Ìrìnàjò Rẹ',
    leave_a_review: 'Fi Ìwòye Sílẹ̀',
    review_submitted: 'Ti fi ìwòye sílẹ̀ — ẹ jẹ́ ẹ dúpẹ́!',
    review_already_submitted: 'O ti fi ìwòye hàn fún ìrìnàjò yìí tẹ́lẹ̀',
    select_trip: 'Yan Ìrìnàjò',
    select_seats_pos: 'Yan Àwọn Ìjókòó',
    cash: 'Owó Nínú Ọwọ́',
    mobile_money: 'Owó Fóònù',
    card: 'Káàdì',
    print_receipt: 'Tẹ Ìjẹ́rìísí',
    sale_complete: 'Títà Ti Parí',
    offline_queued: 'Ti fipamọ́ láìsí Íńtánẹ́ẹ̀tì — yóò ṣọ̀kan nígbà tí a bá sopọ̀',
    pending_sync: 'nduro fún ìṣọ̀kan',
    available: 'Wà',
    reserved: 'Ti Dámọ̀',
    confirmed: 'Ti Jẹ́rìísí',
    blocked: 'Ti Dí',
    scheduled: 'Ti Ṣètò',
    boarding: 'Gbígbé Wọlé',
    in_transit: 'Nínú Ìrìnàjò',
    completed: 'Ti Parí',
    cancelled: 'Ti Fagilé',
    trips_today: 'Àwọn Ìrìnàjò Lónìí',
    total_revenue: 'Owó Àpapọ̀',
    active_agents: 'Àwọn Aṣojú Tó Ń Ṣiṣẹ́',
    manage_routes: 'Ṣàkóso Àwọn Ọ̀nà',
    manage_vehicles: 'Ṣàkóso Àwọn Ọkọ',
    loading: 'Ń gbárùkù...',
    error: 'Àṣìṣe',
    retry: 'Gbìyànjú Lẹ́ẹ̀kan Sí',
    cancel: 'Fagilé',
    confirm: 'Jẹ́rìísí',
    back: 'Padà',
    save: 'Fipamọ́',
    done: 'Parí',
    success: 'Àṣeyọrí',
    online: 'Lórí Íńtánẹ́ẹ̀tì',
    offline: 'Láìsí Íńtánẹ́ẹ̀tì',
    seat_no_longer_available: 'Ìjókòó yìí kò sí mọ́',
    payment_failed: 'Ìsanwó kò ṣiṣẹ́. Jọ̀wọ́ gbìyànjú lẹ́ẹ̀kan sí.',
    session_expired: 'Àkókò rẹ ti parí, jọ̀wọ́ wọlé lẹ́ẹ̀kan sí',
    language: 'Èdè',
  },
  ig: {
    app_name: 'WebWaka Ụgbọ',
    dashboard: 'Ebe Njikwa',
    search_trips: 'Chọọ Njem',
    my_bookings: 'Ndekọ M',
    agent_pos: 'POS Onye Nnọchiteanya',
    operator: 'Onye Ọrụ',
    origin: 'Ebe Mbido',
    from: 'Site',
    destination: 'Ebe Ọ Ga-aga',
    to: 'Gaa',
    date: 'Ụbọchị',
    any_date: 'Ụbọchị Ọ Bụla',
    search: 'Chọọ',
    available_seats: 'Oche Dị',
    departure: 'Oge Ọpụpụ',
    departs: 'Ọ Pụọ',
    arrives: 'Ọ Rutere',
    fare: 'Ụgwọ Ụgbọ',
    book_now: 'Dekọ Ugbu a',
    no_trips_found: 'Enweghị njem achọtara',
    sold_out: 'Fooro Onu',
    select_seats: 'Họrọ Oche',
    select_your_seat: 'Họrọ Oche Gị',
    window: 'Windo',
    aisle: 'Ụzọ Etiti',
    vip_class: 'VIP',
    standard_class: 'Ọkwa Ọdịnala',
    passenger_name: 'Aha Onye Njem',
    payment_method: 'Ụzọ Ịkwụ Ụgwọ',
    paystack: 'Paystack',
    flutterwave: 'Flutterwave',
    bank_transfer: 'Nnyefe Ụlọ Akụ',
    confirm_booking: 'Kwado Ndekọ',
    booking_confirmed: 'Akwadoro Ndekọ',
    booking_cancelled: 'Ewepụla Ndekọ',
    proceed_to_payment: 'Gaa Ikwụ Ụgwọ',
    total_amount: 'Ego Niile',
    booking_summary: 'Nchịkọta Ndekọ',
    pay_now: 'Kwụọ Ugbu a',
    ndpr_consent: 'Anabatara m ka ọ jiri data m mee ihe dị ka NDPR si dị',
    ndpr_required: 'Nkwenye NDPR dị mkpa iji gaa n\'ihu',
    your_ticket: 'Tiketi Gị',
    view_eticket: 'Lelee E-Tiketi',
    share_via_whatsapp: 'Kekọrịta site WhatsApp',
    rate_your_trip: 'Nyochaa Njem Gị',
    leave_a_review: 'Hapụ Nyocha',
    review_submitted: 'Ezitela nyocha — daalụ!',
    review_already_submitted: 'Ị aghachiekwola nyocha maka njem a',
    select_trip: 'Họrọ Njem',
    select_seats_pos: 'Họrọ Oche',
    cash: 'Ego Aka',
    mobile_money: 'Ego Ekwentị',
    card: 'Kaadị',
    print_receipt: 'Bipụta Rịsịt',
    sale_complete: 'Ire Ahịa Gụchara',
    offline_queued: 'Echekwara n\'ụlọ — ga-emekọ ihe mgbe ọ jikọọ',
    pending_sync: 'na-atọ ụzọ mekọ ihe',
    available: 'Dị',
    reserved: 'Echekwara',
    confirmed: 'Akwadoro',
    blocked: 'Mechiri',
    scheduled: 'Atọla Oge',
    boarding: 'Ọbụbụ Ụgbọ',
    in_transit: 'N\'ụzọ',
    completed: 'Gụchara',
    cancelled: 'Ewepụla',
    trips_today: 'Njem Taa',
    total_revenue: 'Ego Niile',
    active_agents: 'Ndị Nnọchiteanya Na-arụ Ọrụ',
    manage_routes: 'Jikwaa Ụzọ',
    manage_vehicles: 'Jikwaa Ụgbọ',
    loading: 'Na-ebu...',
    error: 'Njehie',
    retry: 'Nwaa Ọzọ',
    cancel: 'Kagbuo',
    confirm: 'Kwado',
    back: 'Laghachi',
    save: 'Chekwaa',
    done: 'Emechara',
    success: 'Ọ Dị Mma',
    online: 'Na-Ịntanetị',
    offline: 'Enweghị Ịntanetị',
    seat_no_longer_available: 'Oche a adịghị ọzọ',
    payment_failed: 'Ikwụ ụgwọ enweghị ike. Biko nwaa ọzọ.',
    session_expired: 'Oge gachara, biko banye ọzọ',
    language: 'Asụsụ',
  },
  ha: {
    app_name: 'WebWaka Mota',
    dashboard: 'Allon Sarrafa',
    search_trips: 'Nemi Tafiya',
    my_bookings: 'Ajiyata',
    agent_pos: 'POS Wakili',
    operator: 'Mai Aiki',
    origin: 'Wurin Tashi',
    from: 'Daga',
    destination: 'Wurin Zuwa',
    to: 'Zuwa',
    date: 'Kwanan Wata',
    any_date: 'Kowace Rana',
    search: 'Nema',
    available_seats: 'Kujeru Masu Samuwa',
    departure: 'Lokacin Tashi',
    departs: 'Ya Tashi',
    arrives: 'Ya Isa',
    fare: 'Kuɗin Mota',
    book_now: 'Yi Ajiya Yanzu',
    no_trips_found: 'Ba a sami tafiya ba',
    sold_out: 'Komai Ya Tafi',
    select_seats: 'Zaɓi Kujeru',
    select_your_seat: 'Zaɓi Kujerunka',
    window: 'Taga',
    aisle: 'Hanyar Tsakiya',
    vip_class: 'VIP',
    standard_class: 'Na Yau da Kullum',
    passenger_name: 'Sunan Fasinja',
    payment_method: 'Hanyar Biyan Kuɗi',
    paystack: 'Paystack',
    flutterwave: 'Flutterwave',
    bank_transfer: 'Canja Kuɗi ta Banki',
    confirm_booking: 'Tabbatar da Ajiya',
    booking_confirmed: 'An Tabbatar da Ajiya',
    booking_cancelled: 'An Soke Ajiya',
    proceed_to_payment: 'Tafi Biyan Kuɗi',
    total_amount: 'Jimillar Kuɗi',
    booking_summary: 'Taƙaitawar Ajiya',
    pay_now: 'Biya Yanzu',
    ndpr_consent: 'Na yarda da sarrafa bayananmu bisa ka\'idar NDPR ta Najeriya',
    ndpr_required: 'Ana buƙatar izinin NDPR don ci gaba',
    your_ticket: 'Tiketin Ka',
    view_eticket: 'Dubi E-Tiketi',
    share_via_whatsapp: 'Raba ta WhatsApp',
    rate_your_trip: 'Ƙiyasta Tafiyarka',
    leave_a_review: 'Bar Sharhi',
    review_submitted: 'An aika sharhi — na gode!',
    review_already_submitted: 'Ka riga ka ba da sharhi game da wannan tafiyar',
    select_trip: 'Zaɓi Tafiya',
    select_seats_pos: 'Zaɓi Kujeru',
    cash: 'Kuɗi Hannu',
    mobile_money: 'Kuɗin Wayar Salula',
    card: 'Kati',
    print_receipt: 'Buga Rasit',
    sale_complete: 'An Kammala Siyarwa',
    offline_queued: 'An adana ba tare da Intanet ba — za a haɗa idan an haɗa',
    pending_sync: 'yana jiran haɗawa',
    available: 'Akwai',
    reserved: 'An Ajiye',
    confirmed: 'An Tabbatar',
    blocked: 'An Toshe',
    scheduled: 'An Shirya',
    boarding: 'Shiga Mota',
    in_transit: 'Cikin Tafiya',
    completed: 'An Kammala',
    cancelled: 'An Soke',
    trips_today: 'Tafiye-tafiye Yau',
    total_revenue: 'Jimillar Kuɗi',
    active_agents: 'Wakilai Masu Aiki',
    manage_routes: 'Sarrafa Hanyoyi',
    manage_vehicles: 'Sarrafa Motoci',
    loading: 'Ana lodawa...',
    error: 'Kuskure',
    retry: 'Sake Gwadawa',
    cancel: 'Soke',
    confirm: 'Tabbatar',
    back: 'Koma',
    save: 'Ajiye',
    done: 'An Gama',
    success: 'Nasara',
    online: 'Kan Layi',
    offline: 'Ba Kan Layi',
    seat_no_longer_available: 'Wannan kujera ba ta nan ƙara',
    payment_failed: 'Biyan kuɗi ya kasa. Da fatan a sake gwadawa.',
    session_expired: 'Lokacin ya ƙare, da fatan a shiga ƙara',
    language: 'Harshe',
  },
};

const SUPPORTED_LANGUAGES: Language[] = ['en', 'yo', 'ig', 'ha'];

function readStoredLanguage(): Language {
  try { return (localStorage?.getItem('trn_language') as Language) ?? 'en'; } catch { return 'en'; }
}
let currentLanguage: Language = readStoredLanguage();

/**
 * Auto-detect language from browser navigator.language on first visit.
 * Maps browser locale codes to the four supported languages.
 * If the user has already stored a preference, this is a no-op.
 */
export function autoDetectLanguage(): void {
  try {
    if (localStorage?.getItem('trn_language')) return; // user already chose
    const nav = navigator?.language ?? '';
    const tag = nav.toLowerCase().split('-')[0] ?? '';
    // yor → Yorùbá, ig/ibo → Igbo, ha/hau → Hausa
    const map: Record<string, Language> = {
      yor: 'yo', yo: 'yo',
      ig: 'ig', ibo: 'ig',
      ha: 'ha', hau: 'ha',
    };
    const detected = map[tag];
    if (detected && SUPPORTED_LANGUAGES.includes(detected)) {
      setLanguage(detected);
    }
  } catch { /* SSR or restricted env — silent */ }
}

export function t(key: string): string {
  return translations[currentLanguage]?.[key] ?? translations.en[key] ?? key;
}

export function setLanguage(lang: Language): void {
  currentLanguage = lang;
  try { localStorage?.setItem('trn_language', lang); } catch { /* SSR */ }
}

export function getLanguage(): Language {
  return currentLanguage;
}

export function getSupportedLanguages(): Array<{ code: Language; name: string }> {
  return [
    { code: 'en', name: 'English' },
    { code: 'yo', name: 'Yorùbá' },
    { code: 'ig', name: 'Igbo' },
    { code: 'ha', name: 'Hausa' },
  ];
}

// ============================================================
// Multi-Currency — Phase E
// Supported markets: Nigeria, Ghana, Kenya, Uganda, Rwanda
// All stored amounts are in the smallest sub-unit × subunitFactor.
//   NGN: 100 kobo = 1 naira   GHS: 100 pesewa = 1 cedi
//   KES: 100 cents = 1 shilling
//   UGX/RWF: no sub-unit (factor 1, fractionDigits 0)
// ============================================================

export type CurrencyCode = 'NGN' | 'GHS' | 'KES' | 'UGX' | 'RWF';

export interface CurrencyConfig {
  code: CurrencyCode;
  symbol: string;
  subunitFactor: number;
  locale: string;
  flag: string;
  name: string;
  fractionDigits: number;
}

const CURRENCY_CONFIG: Record<CurrencyCode, CurrencyConfig> = {
  NGN: { code: 'NGN', symbol: '₦',    subunitFactor: 100, locale: 'en-NG', flag: '🇳🇬', name: 'Nigerian Naira',    fractionDigits: 2 },
  GHS: { code: 'GHS', symbol: '₵',    subunitFactor: 100, locale: 'en-GH', flag: '🇬🇭', name: 'Ghanaian Cedi',     fractionDigits: 2 },
  KES: { code: 'KES', symbol: 'KSh',  subunitFactor: 100, locale: 'en-KE', flag: '🇰🇪', name: 'Kenyan Shilling',   fractionDigits: 2 },
  UGX: { code: 'UGX', symbol: 'USh',  subunitFactor: 1,   locale: 'en-UG', flag: '🇺🇬', name: 'Ugandan Shilling',  fractionDigits: 0 },
  RWF: { code: 'RWF', symbol: 'RWF ', subunitFactor: 1,   locale: 'en-RW', flag: '🇷🇼', name: 'Rwandan Franc',     fractionDigits: 0 },
};

function readStoredCurrency(): CurrencyCode {
  try { return (localStorage?.getItem('trn_currency') as CurrencyCode) ?? 'NGN'; } catch { return 'NGN'; }
}
let currentCurrency: CurrencyCode = readStoredCurrency();

export function setCurrency(currency: CurrencyCode): void {
  currentCurrency = currency;
  try { localStorage?.setItem('trn_currency', currency); } catch { /* SSR */ }
}

export function getCurrency(): CurrencyCode {
  return currentCurrency;
}

export function getSupportedCurrencies(): Array<CurrencyConfig> {
  return Object.values(CURRENCY_CONFIG);
}

/**
 * Format a stored sub-unit integer for display in the given (or current) currency.
 * e.g. formatAmount(500000, 'NGN') → '₦5,000.00'
 *      formatAmount(10000,  'UGX') → 'USh10,000'
 */
export function formatAmount(subunits: number, currency?: CurrencyCode): string {
  const cfg = CURRENCY_CONFIG[currency ?? currentCurrency];
  const amount = subunits / cfg.subunitFactor;
  return `${cfg.symbol}${amount.toLocaleString(cfg.locale, {
    minimumFractionDigits: cfg.fractionDigits,
    maximumFractionDigits: cfg.fractionDigits,
  })}`;
}

/** Backward-compatible alias — always displays in NGN (kobo → naira). */
export function formatKoboToNaira(kobo: number): string {
  return formatAmount(kobo, 'NGN');
}
