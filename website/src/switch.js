class Component extends DCLogic {
  constructor(props) {
    super(props);
    this.state = { tick: 0, cat: 0 };
    this.names = ['Meeting notes', 'Q4 Planning', 'Reading list', 'Client list', 'Habit tracker', 'Thesis', 'Recipes', 'Job applications', 'Weekly review', 'Travel Lisbon'];
  }
  static cmpData() {
    return [
      { k: 'Setup', n: [3, 'Sign up and start writing. Everything works in the browser.'], b: [3, 'Install, import your Notion export, done. Settings for anyone who wants to tweak.'], o: [2, 'Writing works in seconds. Databases, sync and AI mean plugins, add-ons and configuration.'] },
      { k: 'Speed', n: [1, 'Big databases and pages with inline views slow down; Notion\u2019s help center lists the causes.'], b: [3, 'Local queries and virtualised views. A hundred thousand rows feel like ten.'], o: [3, 'Plain files on your disk. Very fast.'] },
      { k: 'Your data', n: [1, 'Stored in the US by default; EU only on Enterprise. No end-to-end encryption.'], b: [3, 'On your devices. Based Cloud on EU servers, end-to-end encrypted by release.'], o: [3, 'Markdown files on your disk. Optional Sync is end-to-end encrypted.'] },
      { k: 'Databases', n: [3, 'The reference: every view, relations, rollups, formulas.'], b: [3, 'The same model: table, board, calendar, timeline, relations, rollups, pages in rows.'], o: [2, 'Bases adds table, cards, list and map views. Kanban and calendar are still on the roadmap.'] },
      { k: 'Backups', n: [1, 'Page history 7, 30 or 90 days by plan. The export can\u2019t restore a workspace.'], b: [3, 'Every version kept, three copies, restore in one click.'], o: [2, 'Your files, your backups. Sync keeps 1 month of history, 12 on Plus.'] },
      { k: 'AI and agents', n: [2, 'Notion AI and Agents on the Business plan; Custom Agents run on credits.'], b: [3, 'Opt-in agents that orchestrate, your own keys or local models, MCP, every edit marked.'], o: [1, 'Community plugins, set up by you.'] },
      { k: 'Mobile and sync', n: [3, 'Every platform today, synced out of the box.'], b: [1, 'Beta is Mac only with iCloud. Phone, web and Based Cloud come with the release.'], o: [2, 'Apps everywhere. Sync is $4 a month, or set it up yourself.'] },
      { k: 'Teams', n: [3, 'Mature sharing, permissions, admin and SSO.'], b: [1, 'Built for one person first. Collaboration is planned.'], o: [1, 'Shared vaults through Sync.'] },
      { k: 'Price', n: [2, 'Free for one person. Plus $10 and Business $20 per seat a month.'], b: [2, 'Free beta. Pricing decided after the beta.'], o: [3, 'Free. Sync from $4 a month.'] }
    ];
  }
  componentDidMount() { this.timer = setInterval(() => this.setState({ tick: this.state.tick + 1 }), 900); }
  componentWillUnmount() { clearInterval(this.timer); }
  hash(i) {
    const hex = '0123456789abcdef';
    let s = '';
    let x = (i + 7) * 2654435761 % 4294967296;
    for (let k = 0; k < 32; k++) { x = (x * 1103515245 + 12345) % 2147483648; s += hex[x % 16]; }
    return s;
  }
  static words(text, start, step) { return text.split(' ').map((w, i, a) => ({ c: w + (i < a.length - 1 ? ' ' : ''), d: (start + i * step) + 'ms' })); }
  renderVals() {
    const theme = this.props.theme ?? 'light';
    const dark = theme === 'dark';
    const t = this.state.tick;
    const cycle = t % 40;
    const count = Math.min(1284, Math.round(cycle * 34.7));
    const files = [];
    for (let i = 0; i < 5; i++) {
      const idx = (t - i + 1000) % this.names.length;
      const n = this.names[idx];
      files.push({ from: n + ' ' + this.hash(idx) + '.md', to: n + '.md' });
    }
    return {
      theme,
      markSrc: dark ? '/_blob/60426240b69c9dab9372c2741257d898' : '/_blob/c3ccc021887376abcf7fe08d0002d913',
      hw1: Component.words('Love Notion?', 0, 120),
      hw2: Component.words('Keep the good part.', 380, 140),
      cats: Component.cmpData().map((c, i) => ({ label: c.k, on: this.state.cat === i ? 'true' : 'false', bg: this.state.cat === i ? 'var(--button)' : 'var(--surface-raised)', fg: this.state.cat === i ? 'var(--button-ink)' : 'var(--ink)', pick: () => this.setState({ cat: i }) })),
      catLabel: Component.cmpData()[this.state.cat].k,
      cmp: (() => {
        const c = Component.cmpData()[this.state.cat];
        const max = Math.max(c.n[0], c.b[0], c.o[0]);
        const card = (name, v, based, d) => ({
          n: name, t: v[1], d, best: v[0] === max,
          bg: based ? '#1F1F1D' : 'var(--surface-raised)', fg: based ? '#F4F4F1' : 'var(--ink)', sh: based ? 'var(--shadow-big)' : 'none',
          scoreLabel: v[0] + ' of 3',
          dots: [1, 2, 3].map((k) => ({ c: k <= v[0] ? (based ? '#E0C24A' : 'var(--ink)') : (based ? 'rgba(255,255,255,.15)' : 'var(--selected)') }))
        });
        return [card('Notion', c.n, false, '0ms'), card('Based', c.b, true, '80ms'), card('Obsidian', c.o, false, '160ms')];
      })(),
      tally: (() => {
        const t = { Notion: 0, Based: 0, Obsidian: 0 };
        Component.cmpData().forEach((c) => { const m = Math.max(c.n[0], c.b[0], c.o[0]); if (c.n[0] === m) t.Notion++; if (c.b[0] === m) t.Based++; if (c.o[0] === m) t.Obsidian++; });
        return [{ n: 'Based', k: t.Based, c: '#E0C24A' }, { n: 'Notion', k: t.Notion, c: 'var(--ink)' }, { n: 'Obsidian', k: t.Obsidian, c: 'var(--control-border)' }];
      })(),
      impCount: count.toLocaleString('en-US'),
      impPct: Math.round(count / 12.84) + '%',
      files,
      pains: [
        { n: '01', title: 'Your workspace lives in the US', notion: 'By default your workspace data resides in the United States. Moving it to the EU is an Enterprise plan feature, arranged through an account team.', src: 'Notion help center: data residency', url: 'https://www.notion.com/help/data-residency', based: 'Your data lives on your devices first. Based Cloud runs on EU servers, and it\u2019s built in Vienna.' },
        { n: '02', title: 'No end-to-end encryption', notion: 'Notion can technically read your workspace. Users have asked for end-to-end encryption for years.', src: 'Hacker News discussion', url: 'https://news.ycombinator.com/item?id=44594790', based: 'By release, everything is encrypted on your device before it syncs. Cloud agents only decrypt the pages you hand them, while they work.' },
        { n: '03', title: 'The backup that can\u2019t restore', notion: 'Notion\u2019s own docs say you can\u2019t recreate a workspace by re-uploading its export. Paid backup services say a complete restore isn\u2019t possible through the API.', src: 'Reddit r/Notion, Notion Backups FAQ', url: 'https://notionbackups-static.pages.dev/', based: 'Three copies: your device, your encrypted cloud and automatic snapshots to a folder you choose. Restore is one click.' },
        { n: '04', title: 'When the API blinks, data goes', notion: 'On April 21, 2026, records went missing from Notion\u2019s API responses for hours, and connected sync tools passed on the deletions.', src: 'Whalesync status page', url: 'https://status.whalesync.com/incident/876495', based: 'Your copy is local and authoritative. An outage somewhere else can\u2019t delete what\u2019s on your machine.' },
        { n: '05', title: 'Page history has an expiry date', notion: 'Free keeps 7 days of page history, Plus 30, Business 90. Older versions need a bigger plan.', src: 'notion.com/pricing', url: 'https://www.notion.com/pricing', based: 'Every version of every page, on every plan. Agent edits can be undone one by one.' },
        { n: '06', title: 'Offline, with an asterisk', notion: 'You pick pages to download per device. Databases bring the first 50 rows of the first view; formulas, relations and rollups need a connection.', src: 'Notion offline mode guides', url: 'https://matthiasfrank.de/en/notion-features/notion-offline-mode/', based: 'Offline is the default. Every row, every formula, every view.' },
        { n: '07', title: 'Big databases, long waits', notion: 'Notion\u2019s help center names page count, visible properties and formula or rollup sorts as the things that slow databases down.', src: 'Notion help center, summarised by Falconer', url: 'https://falconer.com/guides/why-is-notion-slow/', based: 'Queries run locally against your own copy and every view is virtualised. A hundred thousand rows feel like ten.' },
        { n: '08', title: 'Your AI, their upsell', notion: 'Notion Agent and AI Meeting Notes come with Business at $20 per seat a month. Custom Agents run on credits at $10 per 1,000. On Business, AI data is retained by model providers for 30 days.', src: 'notion.com/pricing', url: 'https://www.notion.com/pricing', based: 'Connect the ChatGPT or Claude account you already pay for, an API key or a local model. Or switch AI off entirely.' },
        { n: '09', title: 'The export is a puzzle', notion: 'Every exported file gets a 32-character ID appended. There are whole GitHub projects just to clean that up.', src: 'unmarkdown.com on Notion exports', url: 'https://unmarkdown.com/blog/notion-export-broken', based: 'Markdown with real file names and a lossless archive. Leaving takes one click. We hope you won\u2019t.' },
        { n: '10', title: 'Who wrote this?', notion: 'Text written by you, a teammate or AI looks the same on the page.', src: 'Try it on any page', url: 'https://www.notion.com', based: 'Every line an agent writes carries a marker and its source in the margin.' }
      ],
      miss: [
        { t: 'Real-time team editing', d: 'Presence, cursors and shared pages are planned. Today Based is built for one person first.' },
        { t: 'Phones', d: 'Mac first. iPhone and Android come on the same core.' },
        { t: 'Notion Sites and Forms', d: 'Publishing to the web is on the roadmap; forms come later.' },
        { t: 'A template gallery', d: 'Coming after the beta. Your imported templates work from day one.' }
      ]
    };
  }
}
