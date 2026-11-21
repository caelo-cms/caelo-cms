// SPDX-License-Identifier: MPL-2.0

/**
 * A labelled site-search set for choosing the embedding model (#1650).
 *
 * Three small sites in one index, as a site search sees them: pages split
 * into sections (heading + text, the `passages` field). A SaaS product
 * (German, part English), a town's citizen services (German, two English
 * pages) and an outdoor shop (German, part English). The pages are written
 * the way such sites are; the queries the way visitors type them: short,
 * often without the page's words, sometimes a question, sometimes in the
 * other language. Each query names the pages that answer it (`relevant`).
 *
 * Query kinds:
 *   - `lexical`: the page's own words (the word index already finds these);
 *   - `paraphrase`: the need in other words ("Kosten" for a price page);
 *   - `question`: a question in natural language;
 *   - `cross`: the query's language differs from the only page that answers.
 *
 * Small on purpose (a hand-labelled set has to be read to be trusted); the
 * bench reports per kind, so a model that wins only on lexical queries
 * shows it.
 */

/** One page of the set. */
export interface EvalPage {
  readonly id: string;
  readonly lang: "de" | "en";
  readonly title: string;
  readonly sections: readonly {
    readonly anchor: string;
    readonly heading: string;
    readonly text: string;
  }[];
}

/** One labelled query. */
export interface EvalQuery {
  readonly q: string;
  readonly lang: "de" | "en";
  readonly kind: "lexical" | "paraphrase" | "question" | "cross";
  /** Page ids that answer it. */
  readonly relevant: readonly string[];
}

const s = (anchor: string, heading: string, text: string) => ({ anchor, heading, text });

export const EVAL_PAGES: readonly EvalPage[] = [
  // --- A SaaS product for SEO teams -------------------------------------
  {
    id: "saas/preise",
    lang: "de",
    title: "Preise",
    sections: [
      s(
        "pakete",
        "Pakete",
        "Starter für 49 € im Monat, Professional für 199 € und Agentur für 499 €. Alle Pakete sind monatlich kündbar.",
      ),
      s(
        "zahlung",
        "Rechnung und Zahlung",
        "Sie zahlen per Kreditkarte, SEPA-Lastschrift oder auf Rechnung. Bei jährlicher Zahlung sind zwei Monate gratis.",
      ),
      s(
        "test",
        "Testphase",
        "Testen Sie 14 Tage ohne Kosten. Eine Kreditkarte brauchen Sie dafür nicht.",
      ),
    ],
  },
  {
    id: "saas/logfile",
    lang: "de",
    title: "Logfile-Analyse",
    sections: [
      s(
        "crawler",
        "Was Crawler wirklich sehen",
        "Wir werten die Logdateien Ihres Servers aus: wann der Googlebot welche Seiten abruft, wo er Zeit verliert und welche Seiten er nie besucht.",
      ),
      s(
        "einrichtung",
        "Einrichtung",
        "Laden Sie die Logs per SFTP oder aus einem S3-Bucket hoch. Apache- und Nginx-Formate werden automatisch erkannt.",
      ),
    ],
  },
  {
    id: "saas/migration",
    lang: "de",
    title: "Website-Migration",
    sections: [
      s(
        "relaunch",
        "Relaunch ohne Rankingverlust",
        "Planen Sie die Weiterleitungen vor dem Umzug: Wir vergleichen alte und neue URLs und zeigen, welche Seite wohin gehört.",
      ),
      s(
        "check",
        "Weiterleitungs-Check",
        "Nach dem Go-live finden wir Ketten aus mehreren 301-Weiterleitungen und Seiten, die plötzlich einen Fehler 404 liefern.",
      ),
    ],
  },
  {
    id: "saas/monitoring",
    lang: "de",
    title: "Monitoring",
    sections: [
      s(
        "alarme",
        "Alarme bei Änderungen",
        "Ihre Website wird täglich gecrawlt. Ändert sich ein Title, verschwindet eine Seite aus der Sitemap oder steht plötzlich noindex im Quelltext, bekommen Sie eine E-Mail.",
      ),
    ],
  },
  {
    id: "saas/support",
    lang: "de",
    title: "Hilfe & Support",
    sections: [
      s(
        "kontakt",
        "Kontakt",
        "Unser Support antwortet per E-Mail und im Chat, werktags von 9 bis 17 Uhr.",
      ),
      s(
        "passwort",
        "Passwort zurücksetzen",
        "Klicken Sie auf der Anmeldeseite auf „Passwort vergessen“. Sie erhalten einen Link, mit dem Sie ein neues Passwort setzen.",
      ),
    ],
  },
  {
    id: "saas/karriere",
    lang: "de",
    title: "Karriere",
    sections: [
      s(
        "stellen",
        "Offene Stellen",
        "Wir suchen eine Backend-Entwicklerin oder einen Backend-Entwickler (m/w/d) in Berlin oder remote.",
      ),
      s(
        "bieten",
        "Was wir bieten",
        "30 Urlaubstage, ein Budget für Weiterbildung und Arbeitszeiten, die zu Ihrem Leben passen.",
      ),
    ],
  },
  {
    id: "saas/datenschutz",
    lang: "de",
    title: "Datenschutzerklärung",
    sections: [
      s(
        "cookies",
        "Cookies",
        "Wir setzen nur technisch notwendige Cookies. Statistik-Cookies setzen wir nur, wenn Sie eingewilligt haben.",
      ),
      s(
        "av",
        "Auftragsverarbeitung",
        "Einen Vertrag zur Auftragsverarbeitung nach Art. 28 DSGVO schicken wir Ihnen auf Anfrage zu.",
      ),
    ],
  },
  {
    id: "saas/impressum",
    lang: "de",
    title: "Impressum",
    sections: [
      s(
        "angaben",
        "Angaben gemäß § 5 TMG",
        "Searchlight GmbH, Musterstraße 1, 10115 Berlin. Eingetragen im Handelsregister des Amtsgerichts Charlottenburg.",
      ),
    ],
  },
  {
    id: "saas/blog-crawl-budget",
    lang: "de",
    title: "Crawl-Budget verstehen",
    sections: [
      s(
        "was",
        "Was ist das Crawl-Budget?",
        "Suchmaschinen rufen pro Tag nur eine begrenzte Zahl von Seiten einer Domain ab. Große Shops verschenken dieses Kontingent oft an Filter- und Parameter-URLs.",
      ),
      s(
        "besser",
        "So verbessern Sie es",
        "Starke interne Verlinkung, saubere Sitemaps und weniger Parameter-URLs sorgen dafür, dass wichtige Seiten öfter besucht werden.",
      ),
    ],
  },
  {
    id: "saas/blog-web-vitals",
    lang: "de",
    title: "Core Web Vitals 2026",
    sections: [
      s(
        "metriken",
        "LCP, INP und CLS",
        "Die drei Werte messen, wie schnell der Hauptinhalt lädt, wie schnell die Seite auf Eingaben reagiert und wie stark sich das Layout beim Laden verschiebt.",
      ),
      s(
        "schneller",
        "Schneller laden",
        "Komprimieren Sie Bilder, liefern Sie moderne Formate aus und nutzen Sie Browser-Caching.",
      ),
    ],
  },
  {
    id: "saas/partner",
    lang: "de",
    title: "Partnerprogramm für Agenturen",
    sections: [
      s(
        "provision",
        "Provision",
        "Für jeden vermittelten Kunden erhalten Sie 20 % wiederkehrende Provision, solange der Kunde bleibt.",
      ),
      s(
        "whitelabel",
        "White Label",
        "Berichte erscheinen mit Ihrem eigenen Logo und Ihren Farben.",
      ),
    ],
  },
  {
    id: "saas/en-pricing",
    lang: "en",
    title: "Pricing",
    sections: [
      s(
        "plans",
        "Plans",
        "Starter at €49 per month, Professional at €199 and Agency at €499. Cancel anytime.",
      ),
      s("trial", "Free trial", "Try every feature for 14 days. No credit card required."),
    ],
  },
  {
    id: "saas/en-logfile",
    lang: "en",
    title: "Log file analysis",
    sections: [
      s(
        "see",
        "See what crawlers see",
        "We analyse your server logs: when Googlebot requests which pages, where it wastes time, and which pages it never visits.",
      ),
    ],
  },
  {
    id: "saas/en-contact",
    lang: "en",
    title: "Contact",
    sections: [
      s(
        "sales",
        "Talk to sales",
        "Book a 30-minute demo with our team and see the product on your own website.",
      ),
      s(
        "hours",
        "Support hours",
        "Our support team answers by email and chat on weekdays from 9am to 5pm CET.",
      ),
    ],
  },
  {
    id: "saas/en-hreflang",
    lang: "en",
    title: "Hreflang for international sites",
    sections: [
      s(
        "mistakes",
        "Common mistakes",
        "Missing return links, wrong language codes and canonical tags that point to another language version are the most frequent hreflang errors.",
      ),
      s(
        "check",
        "How to check it",
        "Our crawler lists every page whose hreflang annotations do not confirm each other.",
      ),
    ],
  },

  // --- A town's citizen services ----------------------------------------
  {
    id: "town/personalausweis",
    lang: "de",
    title: "Personalausweis beantragen",
    sections: [
      s(
        "antrag",
        "Antrag",
        "Den Personalausweis beantragen Sie persönlich im Bürgerbüro. Bringen Sie ein biometrisches Passfoto mit. Die Gebühr beträgt 37 Euro.",
      ),
      s(
        "verlust",
        "Verlust melden",
        "Ist Ihr Ausweis verloren gegangen oder gestohlen worden, melden Sie das sofort im Bürgerbüro oder bei der Polizei. Die Online-Funktion wird dann gesperrt.",
      ),
    ],
  },
  {
    id: "town/reisepass",
    lang: "de",
    title: "Reisepass",
    sections: [
      s(
        "antrag",
        "Antrag und Bearbeitungszeit",
        "Ein Reisepass ist nach drei bis vier Wochen abholbereit. Gegen Aufpreis gibt es einen Express-Pass in drei Werktagen.",
      ),
    ],
  },
  {
    id: "town/anmelden",
    lang: "de",
    title: "Wohnsitz anmelden",
    sections: [
      s(
        "umzug",
        "Nach dem Umzug",
        "Melden Sie Ihre neue Wohnung innerhalb von zwei Wochen nach dem Einzug an. Bringen Sie die Wohnungsgeberbestätigung Ihres Vermieters mit.",
      ),
    ],
  },
  {
    id: "town/abfuhrkalender",
    lang: "de",
    title: "Abfuhrkalender",
    sections: [
      s(
        "termine",
        "Termine",
        "Die Restmülltonne wird alle zwei Wochen geleert, die Biotonne im Sommer jede Woche.",
      ),
      s(
        "sperrmuell",
        "Sperrmüll",
        "Zweimal im Jahr holen wir Möbel und große Gegenstände kostenlos ab. Melden Sie die Abholung online an.",
      ),
    ],
  },
  {
    id: "town/wertstoffhof",
    lang: "de",
    title: "Wertstoffhof",
    sections: [
      s(
        "zeiten",
        "Öffnungszeiten",
        "Dienstag bis Freitag von 10 bis 18 Uhr, samstags von 9 bis 14 Uhr.",
      ),
      s(
        "annahme",
        "Was wir annehmen",
        "Elektrogeräte, Grünschnitt und Bauschutt in haushaltsüblichen Mengen.",
      ),
    ],
  },
  {
    id: "town/kita",
    lang: "de",
    title: "Kita-Platz",
    sections: [
      s(
        "anmeldung",
        "Anmeldung",
        "Für einen Platz in einer Kindertagesstätte melden Sie Ihr Kind im Kita-Portal vor. Das geht schon ab der Geburt.",
      ),
      s(
        "beitraege",
        "Beiträge",
        "Die Elternbeiträge richten sich nach dem Einkommen. Für Geschwister gibt es eine Ermäßigung.",
      ),
    ],
  },
  {
    id: "town/bauantrag",
    lang: "de",
    title: "Bauantrag",
    sections: [
      s(
        "pflicht",
        "Wann Sie eine Genehmigung brauchen",
        "Garagen und Anbauten brauchen eine Baugenehmigung. Gartenhäuser bis 30 Kubikmeter sind verfahrensfrei.",
      ),
      s(
        "unterlagen",
        "Unterlagen",
        "Lageplan, Bauzeichnungen und der Nachweis der Standsicherheit gehören zum Antrag.",
      ),
    ],
  },
  {
    id: "town/hundesteuer",
    lang: "de",
    title: "Hundesteuer",
    sections: [
      s(
        "anmeldung",
        "Anmeldung",
        "Melden Sie Ihren Hund innerhalb eines Monats an. Sie erhalten eine Steuermarke.",
      ),
      s(
        "satz",
        "Steuersatz",
        "Für den ersten Hund zahlen Sie 90 Euro im Jahr, für Listenhunde 600 Euro.",
      ),
    ],
  },
  {
    id: "town/rathaus",
    lang: "de",
    title: "Öffnungszeiten Rathaus",
    sections: [
      s(
        "buergerbuero",
        "Bürgerbüro",
        "Montag bis Freitag von 8 bis 12 Uhr, donnerstags bis 18 Uhr. Termine buchen Sie online.",
      ),
    ],
  },
  {
    id: "town/bibliothek",
    lang: "de",
    title: "Stadtbibliothek",
    sections: [
      s(
        "ausleihe",
        "Ausleihe",
        "Der Leseausweis kostet 15 Euro im Jahr, für Kinder ist er kostenlos. E-Books leihen Sie über die Onleihe.",
      ),
    ],
  },
  {
    id: "town/parken",
    lang: "de",
    title: "Parken in der Innenstadt",
    sections: [
      s(
        "anwohner",
        "Anwohnerparken",
        "Wer in der Innenstadt wohnt, kann einen Parkausweis für Anwohner beantragen. Er kostet 30 Euro im Jahr.",
      ),
      s(
        "parkhaeuser",
        "Parkhäuser",
        "Am Markt und am Bahnhof gibt es Parkhäuser mit zusammen 900 Stellplätzen.",
      ),
    ],
  },
  {
    id: "town/stellen",
    lang: "de",
    title: "Stellenangebote der Stadt",
    sections: [
      s(
        "ausbildung",
        "Ausbildung",
        "Wir bilden Verwaltungsfachangestellte aus. Die Ausbildung dauert drei Jahre.",
      ),
      s("bewerbung", "Bewerbung", "Bewerben Sie sich online über unser Bewerberportal."),
    ],
  },
  {
    id: "town/en-welcome",
    lang: "en",
    title: "Welcome to Lindenau",
    sections: [
      s(
        "register",
        "Registering your address",
        "Newcomers must register their address at the citizens' office within two weeks of moving in.",
      ),
      s(
        "waste",
        "Waste and recycling",
        "Bins are emptied on fixed days; the recycling centre takes electrical appliances and garden waste.",
      ),
    ],
  },

  // --- An outdoor shop --------------------------------------------------
  {
    id: "shop/versand",
    lang: "de",
    title: "Versand & Lieferung",
    sections: [
      s(
        "lieferzeit",
        "Lieferzeit",
        "Innerhalb Deutschlands liefern wir in zwei bis vier Werktagen.",
      ),
      s(
        "kosten",
        "Versandkosten",
        "Ab 50 € Bestellwert ist der Versand kostenlos, darunter berechnen wir 4,95 €.",
      ),
      s(
        "ausland",
        "Lieferung ins Ausland",
        "Wir liefern nach Österreich, in die Schweiz und in alle Länder der EU.",
      ),
    ],
  },
  {
    id: "shop/rueckgabe",
    lang: "de",
    title: "Rückgabe & Umtausch",
    sections: [
      s(
        "recht",
        "30 Tage Rückgaberecht",
        "Den Retourenschein drucken Sie in Ihrem Kundenkonto aus. Der Rückversand ist kostenlos.",
      ),
      s(
        "erstattung",
        "Erstattung",
        "Sobald die Ware bei uns ist, bekommen Sie Ihr Geld innerhalb von fünf Tagen zurück.",
      ),
    ],
  },
  {
    id: "shop/zahlung",
    lang: "de",
    title: "Zahlungsarten",
    sections: [
      s(
        "arten",
        "So können Sie bezahlen",
        "PayPal, Kreditkarte, Kauf auf Rechnung mit Klarna oder Vorkasse.",
      ),
    ],
  },
  {
    id: "shop/groessen",
    lang: "de",
    title: "Größentabelle",
    sections: [
      s(
        "jacken",
        "Jacken",
        "Messen Sie Ihren Brustumfang und wählen Sie die passende Größe von S bis XXL.",
      ),
      s(
        "schuhe",
        "Wanderschuhe",
        "Messen Sie Ihre Fußlänge in Zentimetern. Bei Wanderschuhen empfehlen wir eine halbe Nummer größer.",
      ),
    ],
  },
  {
    id: "shop/garantie",
    lang: "de",
    title: "Garantie & Reparatur",
    sections: [
      s(
        "garantie",
        "Lebenslange Garantie",
        "Auf alle Rucksäcke geben wir eine lebenslange Garantie auf Material und Verarbeitung.",
      ),
      s(
        "reparatur",
        "Reparaturservice",
        "Ist ein Reißverschluss kaputt oder eine Naht offen, reparieren wir das in unserer Werkstatt.",
      ),
    ],
  },
  {
    id: "shop/regenjacke",
    lang: "de",
    title: "Regenjacke Fjord",
    sections: [
      s(
        "eigenschaften",
        "Eigenschaften",
        "Wasserdicht mit 20.000 mm Wassersäule, atmungsaktiv und mit verstellbarer Kapuze.",
      ),
      s("pflege", "Pflege", "Bei 30 Grad waschen und danach neu imprägnieren."),
    ],
  },
  {
    id: "shop/zelt",
    lang: "de",
    title: "Zelt Tundra 2",
    sections: [
      s(
        "zwei",
        "Für zwei Personen",
        "Wiegt 1,9 kg, steht in fünf Minuten und hält Wind und Schnee in allen vier Jahreszeiten stand.",
      ),
    ],
  },
  {
    id: "shop/schlafsack",
    lang: "de",
    title: "Schlafsack Polar",
    sections: [
      s("temperatur", "Temperaturbereich", "Komfortbereich bis minus 5 Grad dank Daunenfüllung."),
      s("packmass", "Packmaß", "Im Kompressionsbeutel nur so groß wie eine Literflasche."),
    ],
  },
  {
    id: "shop/zwiebel",
    lang: "de",
    title: "Kleidung im Zwiebelprinzip",
    sections: [
      s(
        "schichten",
        "Drei Schichten",
        "Funktionsunterwäsche leitet Schweiß ab, Fleece wärmt und eine wetterfeste Außenschicht hält Regen und Wind ab.",
      ),
    ],
  },
  {
    id: "shop/filialen",
    lang: "de",
    title: "Filialen",
    sections: [
      s("hamburg", "Hamburg", "Mönckebergstraße 12, Montag bis Samstag von 10 bis 20 Uhr."),
      s("muenchen", "München", "Sendlinger Straße 40, Montag bis Samstag von 10 bis 19 Uhr."),
    ],
  },
  {
    id: "shop/gutscheine",
    lang: "de",
    title: "Geschenkgutscheine",
    sections: [
      s(
        "kaufen",
        "Gutschein kaufen",
        "Den Wert wählen Sie selbst. Der Gutschein kommt als PDF per E-Mail.",
      ),
      s("einloesen", "Gutschein einlösen", "Geben Sie den Code im Warenkorb ein."),
    ],
  },
  {
    id: "shop/en-shipping",
    lang: "en",
    title: "Shipping & delivery",
    sections: [
      s(
        "times",
        "Delivery times",
        "International orders arrive within five to eight business days.",
      ),
      s(
        "customs",
        "Customs",
        "Orders to the United Kingdom and Switzerland may incur customs duties on delivery.",
      ),
    ],
  },
  {
    id: "shop/en-returns",
    lang: "en",
    title: "Returns",
    sections: [
      s(
        "returns",
        "30-day returns",
        "Send any item back within 30 days; we refund the full price.",
      ),
    ],
  },
];

const q = (
  text: string,
  lang: "de" | "en",
  kind: EvalQuery["kind"],
  ...relevant: string[]
): EvalQuery => ({ q: text, lang, kind, relevant });

export const EVAL_QUERIES: readonly EvalQuery[] = [
  // lexical: the page's own words
  q("Logfile Analyse", "de", "lexical", "saas/logfile"),
  q("Preise", "de", "lexical", "saas/preise"),
  q("Hundesteuer", "de", "lexical", "town/hundesteuer"),
  q("Abfuhrkalender", "de", "lexical", "town/abfuhrkalender"),
  q("Reisepass", "de", "lexical", "town/reisepass"),
  q("Größentabelle", "de", "lexical", "shop/groessen"),
  q("Versandkosten", "de", "lexical", "shop/versand"),
  q("Zahlungsarten", "de", "lexical", "shop/zahlung"),
  q("Kita", "de", "lexical", "town/kita"),
  q("Partnerprogramm", "de", "lexical", "saas/partner"),
  q("pricing", "en", "lexical", "saas/en-pricing"),
  q("hreflang", "en", "lexical", "saas/en-hreflang"),
  // paraphrase: the need in other words
  q("Kosten", "de", "paraphrase", "saas/preise"),
  q("was kostet das tool", "de", "paraphrase", "saas/preise"),
  q("kostenlos ausprobieren", "de", "paraphrase", "saas/preise"),
  q("Server Logs auswerten", "de", "paraphrase", "saas/logfile"),
  q("Relaunch planen", "de", "paraphrase", "saas/migration"),
  q("kaputte Weiterleitungen nach Umzug", "de", "paraphrase", "saas/migration"),
  q("Benachrichtigung wenn sich etwas ändert", "de", "paraphrase", "saas/monitoring"),
  q("Login vergessen", "de", "paraphrase", "saas/support"),
  q("Jobs", "de", "paraphrase", "saas/karriere", "town/stellen"),
  q("Urlaub Mitarbeiter", "de", "paraphrase", "saas/karriere"),
  q("DSGVO Vertrag", "de", "paraphrase", "saas/datenschutz"),
  q("Firmenadresse", "de", "paraphrase", "saas/impressum"),
  q("Seitenladezeit verbessern", "de", "paraphrase", "saas/blog-web-vitals"),
  q("Affiliate Agentur", "de", "paraphrase", "saas/partner"),
  q("Ausweis verloren", "de", "paraphrase", "town/personalausweis"),
  q("Perso beantragen", "de", "paraphrase", "town/personalausweis"),
  q("neue Wohnung ummelden", "de", "paraphrase", "town/anmelden"),
  q("Möbel entsorgen", "de", "paraphrase", "town/abfuhrkalender"),
  q("Recyclinghof Öffnungszeiten", "de", "paraphrase", "town/wertstoffhof"),
  q("Kindergarten Anmeldung", "de", "paraphrase", "town/kita"),
  q("Gartenhaus bauen Genehmigung", "de", "paraphrase", "town/bauantrag"),
  q("Bücherei", "de", "paraphrase", "town/bibliothek"),
  q("Parkausweis", "de", "paraphrase", "town/parken"),
  q("Lieferdauer", "de", "paraphrase", "shop/versand"),
  q("Paket zurückschicken", "de", "paraphrase", "shop/rueckgabe"),
  q("Geld zurück", "de", "paraphrase", "shop/rueckgabe"),
  q("Ratenkauf Rechnung", "de", "paraphrase", "shop/zahlung"),
  q("welche Schuhgröße", "de", "paraphrase", "shop/groessen"),
  q("Reißverschluss defekt", "de", "paraphrase", "shop/garantie"),
  q("wasserdichte Jacke", "de", "paraphrase", "shop/regenjacke"),
  q("leichtes Zelt", "de", "paraphrase", "shop/zelt"),
  q("warmer Schlafsack für den Winter", "de", "paraphrase", "shop/schlafsack"),
  q("was anziehen beim Wandern", "de", "paraphrase", "shop/zwiebel"),
  q("Laden in Hamburg", "de", "paraphrase", "shop/filialen"),
  q("Geschenk", "de", "paraphrase", "shop/gutscheine"),
  q("free trial", "en", "paraphrase", "saas/en-pricing"),
  q("book a demo", "en", "paraphrase", "saas/en-contact"),
  // question: natural-language questions
  q("Wie lange dauert ein neuer Reisepass?", "de", "question", "town/reisepass"),
  q("Brauche ich eine Kreditkarte für den Test?", "de", "question", "saas/preise"),
  q("Wann wird die Biotonne geleert?", "de", "question", "town/abfuhrkalender"),
  q("Wann hat das Bürgerbüro geöffnet?", "de", "question", "town/rathaus"),
  q("Wie viel kostet ein Hund im Jahr?", "de", "question", "town/hundesteuer"),
  q("Liefert ihr auch in die Schweiz?", "de", "question", "shop/versand"),
  q("Wie wasche ich die Regenjacke?", "de", "question", "shop/regenjacke"),
  q("Wo löse ich meinen Gutschein ein?", "de", "question", "shop/gutscheine"),
  q("Which pages does Googlebot never visit?", "en", "question", "saas/en-logfile"),
  q("Do I have to pay customs for Switzerland?", "en", "question", "shop/en-shipping"),
  // cross: the only answering page is in the other language
  q("hreflang Fehler", "de", "cross", "saas/en-hreflang"),
  q("Sprachversionen verknüpfen", "de", "cross", "saas/en-hreflang"),
  q("Zoll Großbritannien", "de", "cross", "shop/en-shipping"),
  q("site migration redirects", "en", "cross", "saas/migration"),
  q("change alerts", "en", "cross", "saas/monitoring"),
  q("reset password", "en", "cross", "saas/support"),
  q("job openings", "en", "cross", "saas/karriere", "town/stellen"),
  q("privacy policy cookies", "en", "cross", "saas/datenschutz"),
  q("lost ID card", "en", "cross", "town/personalausweis"),
  q("dog tax", "en", "cross", "town/hundesteuer"),
  q("bulky waste pickup", "en", "cross", "town/abfuhrkalender"),
  q("building permit garden shed", "en", "cross", "town/bauantrag"),
  q("library card", "en", "cross", "town/bibliothek"),
  q("size chart hiking boots", "en", "cross", "shop/groessen"),
  q("payment methods", "en", "cross", "shop/zahlung"),
  q("rain jacket", "en", "cross", "shop/regenjacke"),
  q("gift card", "en", "cross", "shop/gutscheine"),
  q("store opening hours Munich", "en", "cross", "shop/filialen"),
];
