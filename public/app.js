const state = {
  user: null, categories: [], businessCategories: [], serviceCategories: [],
  section: 'consumer', requestType: 'thing', urgentOnly: false, sort: '',
  items: [], requests: [], category: '', priceType: '', q: '', location: '',
  wishlist: new Set(), monthlyBadges: null,
  // Mobile-only Home/Browse split (nav redesign Stage 3) — desktop never reads this; it always
  // shows the single continuous page it always has. 'home' = curated homepage (Trending preview,
  // People asking for help, Champions, compact Impact card). 'browse' = full categories + grid.
  view: 'home'
};

const SECTION_HINTS = {
  consumer: "Give. Find. Reuse. Give away things you no longer need, or find useful items near you.",
  business_waste: "Reusable surplus from businesses — office furniture, equipment, electronics, packaging and more — plus recurring byproducts like metal scrap, cow dung, and used cooking oil. Other businesses or farms can request them.",
  requests: "Post what you NEED instead of what you have — a thing or a service — and let nearby people fulfill it for free, rent, or payment."
};

const $ = sel => document.querySelector(sel);
const modalRoot = $('#modalRoot');
const lightboxRoot = $('#lightboxRoot');

function closeModal() { modalRoot.innerHTML = ''; }

// ---------- image lightbox (click a gallery photo -> full view, zoom toggle, next/prev,
// thumbnail strip) — layers above the regular modal, only ever shows real uploaded photos
// (never generated/replaced), and never touches the original files. ----------
let lightboxImages = [];
let lightboxIndex = 0;
function closeLightbox() { lightboxRoot.innerHTML = ''; document.removeEventListener('keydown', lightboxKeyHandler); }
function lightboxKeyHandler(e) {
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowRight') lightboxGo(1);
  else if (e.key === 'ArrowLeft') lightboxGo(-1);
}
function lightboxGo(delta) {
  lightboxIndex = (lightboxIndex + delta + lightboxImages.length) % lightboxImages.length;
  renderLightbox();
}
function renderLightbox() {
  const total = lightboxImages.length;
  lightboxRoot.innerHTML = `<div class="lightbox-overlay" id="lightboxOverlay">
    <button type="button" class="lightbox-close" id="lightboxClose" aria-label="Close"><i data-lucide="x"></i></button>
    ${total > 1 ? `<button type="button" class="lightbox-nav lightbox-prev" id="lightboxPrev" aria-label="Previous"><i data-lucide="chevron-left"></i></button>` : ''}
    <div class="lightbox-stage">
      <img src="${lightboxImages[lightboxIndex].url}" class="lightbox-img" id="lightboxImg">
    </div>
    ${total > 1 ? `<button type="button" class="lightbox-nav lightbox-next" id="lightboxNext" aria-label="Next"><i data-lucide="chevron-right"></i></button>` : ''}
    ${total > 1 ? `<div class="lightbox-thumbs">${lightboxImages.map((m, i) => `<button type="button" class="lightbox-thumb${i === lightboxIndex ? ' active' : ''}" data-i="${i}"><img src="${m.url}"></button>`).join('')}</div>` : ''}
  </div>`;
  $('#lightboxOverlay').onclick = (e) => { if (e.target.id === 'lightboxOverlay') closeLightbox(); };
  $('#lightboxClose').onclick = closeLightbox;
  if (total > 1) {
    $('#lightboxPrev').onclick = () => lightboxGo(-1);
    $('#lightboxNext').onclick = () => lightboxGo(1);
    lightboxRoot.querySelectorAll('.lightbox-thumb').forEach(t => t.onclick = () => { lightboxIndex = +t.dataset.i; renderLightbox(); });
  }
  const img = $('#lightboxImg');
  img.onclick = () => img.classList.toggle('zoomed');
  if (window.lucide) lucide.createIcons();
}
function openLightbox(images, startIndex) {
  if (!images || !images.length) return;
  lightboxImages = images;
  lightboxIndex = startIndex || 0;
  renderLightbox();
  document.addEventListener('keydown', lightboxKeyHandler);
}

function showModal(html) {
  modalRoot.innerHTML = `<div class="modal-overlay" id="overlay"><div class="modal">
    <button class="close" id="closeModal">&times;</button>${html}</div></div>`;
  $('#closeModal').onclick = closeModal;
  $('#overlay').onclick = (e) => { if (e.target.id === 'overlay') closeModal(); };
}

async function api(url, opts = {}) {
  const res = await fetch(url, { credentials: 'include', ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // A banned user's session is revoked server-side the moment they're banned, and requireAuth
    // rejects any further request with this exact 403 even if the client still thinks it's logged
    // in — catch that here once, centrally, instead of every call site having to special-case it.
    if (res.status === 403 && data.error && data.error.indexOf('suspended') !== -1 && state.user) {
      state.user = null;
      renderNav();
      alert(data.error);
    }
    throw new Error(data.error || 'Request failed');
  }
  return data;
}

// ---------- init ----------
async function init() {
  const me = await api('/api/me');
  state.user = me.user;
  state.categories = me.categories;
  state.businessCategories = me.business_categories;
  state.serviceCategories = me.service_categories;
  renderNav();
  bindSectionTabs();
  bindReqTypeTabs();
  bindTopBar();
  bindBottomNav();
  bindMoreMenu();
  bindMobileMoreMenu();
  const mobileSearchBtn = $('#mobileSearchBtn');
  if (mobileSearchBtn) mobileSearchBtn.onclick = () => {
    document.querySelector('.hero-banner')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => $('#search')?.focus(), 350);
  };
  applySectionUi();
  loadEcoPanel();
  loadStatsStrip();
  loadNearbyActivity();
  bindNearbySection();
  initHeroCarousel();
  loadMonthlyBadges();
  if (state.user) refreshNotifCount();
  $('#impactStripBtn').onclick = () => openImpactModal();
  $('#footerImpactLink').onclick = (e) => { e.preventDefault(); openImpactModal(); };
  // Single delegated listener covers every .owner-name-link rendered anywhere (cards, detail
  // modals, Activity dashboard) — no per-render rebinding needed, and stopPropagation keeps a name
  // click from also triggering the parent card's own onclick (e.g. opening item detail).
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.owner-name-link');
    if (btn) {
      e.preventDefault();
      e.stopPropagation();
      if (btn.dataset.uid) openProfileModal(btn.dataset.uid);
      return;
    }
    // Any click outside the notification bell/panel closes the panel — same "outside click
    // dismisses" convention used by the modal overlay elsewhere in this app.
    if (!e.target.closest('#notifWrap')) closeNotifPanel();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeNotifPanel(); });
  window.addEventListener('scroll', () => {
    document.querySelector('header').classList.toggle('scrolled', window.scrollY > 8);
  }, { passive: true });
  animateSearchPlaceholder();
  checkResetTokenInUrl();
  if (window.lucide) lucide.createIcons();
}

// ---------- hero: static single-line search prompt + Post button (homepage restructure v2) ----------
// No rotation, no per-slide marketing copy — a user landing on the page should read this as
// "search bar", not as a rotating ad for Business Surplus/food/nearby. Business Surplus keeps its
// own visibility via the top-nav tab, the More menu, and its dedicated CTA card further down the
// page (never removed, just no longer sharing the hero banner).
function initHeroCarousel() {
  const titleEl = $('#sectionHint');
  const ctaBtn = $('#heroPostBtn');
  if (titleEl) titleEl.textContent = SECTION_HINTS[state.section] || SECTION_HINTS.consumer;
  if (ctaBtn) ctaBtn.onclick = () => $('#postBtn').click();
}

const SEARCH_EXAMPLES = ['laptops', 'books', 'furniture', 'tools', 'a study table', 'kitchen appliances', 'school bags'];
function animateSearchPlaceholder() {
  const el = $('#search');
  if (!el) return;
  let i = 0;
  setInterval(() => {
    if (document.activeElement === el || el.value) return;
    i = (i + 1) % SEARCH_EXAMPLES.length;
    el.placeholder = `Search ${SEARCH_EXAMPLES[i]}...`;
  }, 2600);
}

// Animate a number counting up from 0 to `target`, used for the impact/stats strip.
function animateCount(el, target, duration = 900) {
  const start = performance.now();
  const from = 0;
  function tick(now) {
    const p = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(from + (target - from) * eased).toLocaleString();
    if (p < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

async function loadStatsStrip() {
  const el = $('#statsStrip');
  if (!el) return;
  try {
    const stats = await api('/api/impact');
    const items = [
      { n: stats.reused_items || 0, label: 'Items reused', icon: 'recycle' },
      { n: stats.total_users || 0, label: 'Members', icon: 'users' },
      { n: stats.completed_requests || 0, label: 'Successful exchanges', icon: 'repeat' },
      { n: stats.active_today || 0, label: 'Active today', icon: 'calendar-check' },
      { n: stats.verified_users || 0, label: 'Verified members', icon: 'shield-check' }
    ];
    el.innerHTML = items.map((s, i) => `<div class="stat"><i data-lucide="${s.icon}" class="stat-icon"></i><span class="num" id="statNum${i}">0</span><span class="label">${s.label}</span></div>`).join('');
    items.forEach((s, i) => animateCount($('#statNum' + i), s.n));
    if (window.lucide) lucide.createIcons();
  } catch (e) { /* non-critical */ }
}

function bindSectionTabs() {
  document.querySelectorAll('.section-tab').forEach(btn => btn.onclick = () => {
    state.section = btn.dataset.section;
    state.category = ''; state.priceType = ''; state.q = ''; state.urgentOnly = false; state.sort = '';
    $('#search').value = '';
    $('#priceFilter').value = '';
    $('#filterUrgent').checked = false;
    $('#filterSort').value = 'newest';
    $('#filtersPanel').style.display = 'none';
    document.querySelectorAll('.section-tab').forEach(b => b.classList.toggle('active', b === btn));
    applySectionUi();
  });
}

function bindReqTypeTabs() {
  document.querySelectorAll('#reqTypeTabs .chip').forEach(btn => btn.onclick = () => {
    state.requestType = btn.dataset.rt;
    state.category = '';
    document.querySelectorAll('#reqTypeTabs .chip').forEach(b => b.classList.toggle('active', b === btn));
    renderCategories();
    loadRequests();
  });
}

function applySectionUi() {
  const isRequests = state.section === 'requests';
  $('#sectionHint').textContent = SECTION_HINTS[state.section];
  $('#reqTypeTabs').style.display = isRequests ? 'flex' : 'none';
  $('#priceFilter').style.display = isRequests ? 'none' : '';
  $('#trendingSection').innerHTML = '';
  $('#urgentSection').innerHTML = '';
  if ($('#serviceRequestsSection')) $('#serviceRequestsSection').innerHTML = '';
  $('#urgentFoodSection').innerHTML = '';
  $('#businessSurplusIntro').innerHTML = '';
  $('#communitySection').innerHTML = '';
  $('#businessTeaserSection').innerHTML = '';
  $('#collectionsSection').innerHTML = '';
  $('#businessTeaserPreviewSection').innerHTML = '';
  if ($('#businessAsideCard')) $('#businessAsideCard').innerHTML = '';
  // The global header CTA is intentionally static "+ Post" now (not context-relabeled) — it opens
  // the same 4-option chooser (Give/Exchange item, Item request, Service request, Business
  // surplus) regardless of which section you're browsing, so posting a request never feels
  // hidden just because you're on the Give & Take tab. See #postBtn's click handler below.
  if (window.lucide) lucide.createIcons();
  renderCategories();
  renderQuickCategories();
  if (isRequests) { loadRequests(); } else { loadItems(); loadTrending(); }
  loadBusinessTeaser();
  loadBusinessAsideCard();
  if (state.section === 'consumer') {
    // Homepage order: Urgent Requests -> Urgent Food Rescue -> Trending (tabs) -> Categories+Products+Impact -> Community Story -> Business teaser -> Popular Collections.
    loadUrgentRequests();
    loadServiceRequestsPreview();
    loadUrgentFood();
    loadCollections();
    loadCommunityStory();
    // Mobile-homepage-only preview strip (see .mobile-only-section — never visible on desktop).
    loadBusinessSurplusTeaser();
  }
  if (state.section === 'business_waste') loadBusinessSurplusIntro();
  loadEcoPanel();
}

async function loadUrgentRequests() {
  const el = $('#urgentSection');
  const items = await api('/api/requests/urgent');
  if (!items.length) { el.innerHTML = ''; return; }
  const shown = items.slice(0, 3);
  el.innerHTML = `<div class="highlight-wrap hl-urgent">
    <h2><i data-lucide="hand-heart" class="section-icon"></i> People asking for help ${items.length > 3 ? `<button class="view-all-link" id="urgentViewAll">View all (${items.length}) →</button>` : ''}</h2>
    <p class="highlight-sub">People who need help right now — respond if you can.</p>
    <div class="grid hscroll">${shown.map(requestCardHtml).join('')}</div>
  </div>`;
  el.querySelectorAll('.card').forEach(c => c.onclick = () => openRequestDetail(c.dataset.id));
  if ($('#urgentViewAll')) $('#urgentViewAll').onclick = () => openUrgentAllModal(items);
  if (window.lucide) lucide.createIcons();
}

// Dedicated "Service requests" discovery strip — distinct from item requests (electrician,
// plumber, carpenter, etc. vs "need a bicycle"). Uses the existing /api/requests?request_type=
// service endpoint and requestCardHtml() (already renders the 🛠️ icon + Service badge), so this
// is a new homepage section, not new backend functionality.
async function loadServiceRequestsPreview() {
  const el = $('#serviceRequestsSection');
  if (!el) return;
  if (state.section === 'requests') { el.innerHTML = ''; return; }
  let items = [];
  try { items = await api('/api/requests?request_type=service&sort=newest'); } catch (e) { /* non-critical */ }
  if (!items.length) { el.innerHTML = ''; return; }
  const shown = items.slice(0, 3);
  el.innerHTML = `<div class="highlight-wrap hl-service">
    <h2><i data-lucide="wrench" class="section-icon"></i> Services people need ${items.length > 3 ? `<button class="view-all-link" id="serviceReqViewAll">View all (${items.length}) →</button>` : ''}</h2>
    <p class="highlight-sub">Electrician, plumber, carpenter and more — offer your help nearby.</p>
    <div class="grid hscroll">${shown.map(requestCardHtml).join('')}</div>
  </div>`;
  el.querySelectorAll('.card').forEach(c => c.onclick = () => openRequestDetail(c.dataset.id));
  if ($('#serviceReqViewAll')) $('#serviceReqViewAll').onclick = () => openServiceRequestsAllModal(items);
  if (window.lucide) lucide.createIcons();
}
function openServiceRequestsAllModal(items) {
  showModal(`<h2><i data-lucide="wrench" class="section-icon"></i> All service requests</h2><div class="grid" style="margin-top:14px">${items.map(requestCardHtml).join('')}</div>`);
  modalRoot.querySelectorAll('.card').forEach(c => c.onclick = () => { closeModal(); openRequestDetail(c.dataset.id); });
  if (window.lucide) lucide.createIcons();
}

async function loadUrgentFood() {
  const el = $('#urgentFoodSection');
  // Scoped to consumer-side listings only, so this homepage strip doesn't mix in urgent Business
  // Surplus items — those get their own highlight on the Business Surplus page instead.
  const items = await api('/api/items/urgent?listing_type=consumer');
  if (!items.length) { el.innerHTML = ''; return; }
  const shown = items.slice(0, 3);
  el.innerHTML = `<div class="highlight-wrap hl-urgent">
    <h2><i data-lucide="flame" class="section-icon"></i> Urgent Food Rescue ${items.length > 3 ? `<button class="view-all-link" id="urgentFoodViewAll">View all (${items.length}) →</button>` : ''}</h2>
    <p class="highlight-sub">Surplus food that needs to find a home soon.</p>
    <div class="grid hscroll">${shown.map(cardHtml).join('')}</div>
  </div>`;
  el.querySelectorAll('.card').forEach(c => c.onclick = () => openDetail(c.dataset.id));
  bindWishlistButtons(el);
  if ($('#urgentFoodViewAll')) $('#urgentFoodViewAll').onclick = () => openUrgentFoodAllModal(items);
  if (window.lucide) lucide.createIcons();
}

// Business Surplus page intro + its own urgent highlight — deliberately NOT a homepage strip
// (per design decision: a second "Urgent" section on the homepage next to Urgent Food Rescue
// would be repetitive/crowded). This only renders while state.section === 'business_waste'.
async function loadBusinessSurplusIntro() {
  const el = $('#businessSurplusIntro');
  const items = await api('/api/items/urgent?listing_type=business_waste');
  const shown = items.slice(0, 3);
  el.innerHTML = `<div class="highlight-wrap biz-surplus-intro">
    <h2>🏪 Business Surplus</h2>
    <p class="highlight-sub">Reusable equipment, furniture, electronics and materials from businesses — plus recurring byproducts businesses and farms can put to use.</p>
    ${shown.length ? `
      <h3 class="biz-urgent-heading">🔥 Urgent right now</h3>
      <div class="grid hscroll">${shown.map(cardHtml).join('')}</div>
      ${items.length > 3 ? `<button class="view-all-link" id="bizUrgentViewAll">View all urgent (${items.length}) →</button>` : ''}
    ` : ''}
  </div>`;
  el.querySelectorAll('.card').forEach(c => c.onclick = () => openDetail(c.dataset.id));
  bindWishlistButtons(el);
  if ($('#bizUrgentViewAll')) $('#bizUrgentViewAll').onclick = () => openUrgentFoodAllModal(items, '🔥 All urgent business surplus');
}

// ---------- mobile-homepage-only preview strip ----------
// No equivalent exists on desktop today (Business Surplus is only browsable via the top nav tab
// there) — exists purely so the mobile homepage can show a taste of it without switching tabs.
// 100% reuse: same API endpoint, same card renderer, same .highlight-wrap/.grid.hscroll styling
// as the urgent strips above. Hidden by CSS on desktop (.mobile-only-section), so calling this on
// every load is harmless there — nothing new is ever visible outside the mobile breakpoint.
async function loadBusinessSurplusTeaser() {
  const el = $('#businessTeaserPreviewSection');
  if (!el) return;
  if (state.section !== 'consumer') { el.innerHTML = ''; return; }
  try {
    const items = await api('/api/items?listing_type=business_waste');
    if (!items.length) {
      el.innerHTML = `<div class="mini-cta">
        <p>🏢 No business surplus listed nearby yet.</p>
        <button class="primary-btn" id="bizTeaserPostBtn">Explore Business Surplus</button>
      </div>`;
      $('#bizTeaserPostBtn').onclick = () => document.querySelector('.section-tab[data-section="business_waste"]').click();
      return;
    }
    const shown = items.slice(0, 4);
    el.innerHTML = `<div class="highlight-wrap">
      <h2>🏢 Business Surplus <button class="view-all-link" id="bizTeaserViewAll">View all →</button></h2>
      <div class="grid hscroll">${shown.map(cardHtml).join('')}</div>
    </div>`;
    el.querySelectorAll('.card').forEach(c => c.onclick = () => openDetail(c.dataset.id));
    bindWishlistButtons(el);
    $('#bizTeaserViewAll').onclick = () => document.querySelector('.section-tab[data-section="business_waste"]').click();
  } catch (e) { /* non-critical */ }
}

function openUrgentFoodAllModal(items, title) {
  showModal(`<h2>${title || '🔥 All urgent food listings'}</h2><div class="grid" style="margin-top:14px">${items.map(cardHtml).join('')}</div>`);
  modalRoot.querySelectorAll('.card').forEach(c => c.onclick = () => { closeModal(); openDetail(c.dataset.id); });
  bindWishlistButtons(modalRoot);
}

function openUrgentAllModal(items) {
  showModal(`<h2>🚨 All urgent requests</h2><div class="grid" style="margin-top:14px">${items.map(requestCardHtml).join('')}</div>`);
  modalRoot.querySelectorAll('.card').forEach(c => c.onclick = () => { closeModal(); openRequestDetail(c.dataset.id); });
}

// Compact "Popular Collections" — replaces the old full-height Construction/Educational grids with small
// 3-item previews + "View all" (which just applies the category filter), keeping the homepage short.
async function loadCollections() {
  const el = $('#collectionsSection');
  if (!el) return;
  if (state.section !== 'consumer') { el.innerHTML = ''; return; }
  try {
    const [highlightGroups, furniture, electronics] = await Promise.all([
      api('/api/home-highlights'),
      api('/api/items?listing_type=consumer&category=' + encodeURIComponent('Furniture')),
      api('/api/items?listing_type=consumer&category=' + encodeURIComponent('Electronics & Phones'))
    ]);
    const groups = [
      ...highlightGroups.map(g => ({ icon: g.icon, label: g.label, items: g.items })),
      { icon: '🛋️', label: 'Furniture', items: furniture },
      { icon: '📱', label: 'Electronics & Phones', items: electronics }
    ];
    const cards = groups.map(g => {
      const groupItems = g.items.slice(0, 3);
      if (!groupItems.length) return '';
      return `<div class="collection-card">
        <div class="collection-head"><h3>${g.icon} ${escapeHtml(g.label)}</h3><button class="view-all-link" data-cat="${escapeHtml(groupItems[0].category)}">View all →</button></div>
        <div class="collection-mini-grid">${groupItems.map(i => `<div class="mini-thumb" data-id="${i.id}">${thumbInnerHtml(i)}</div>`).join('')}</div>
      </div>`;
    }).filter(Boolean).join('');
    if (!cards) { el.innerHTML = ''; return; }
    el.innerHTML = `<div class="section-head"><h2><i data-lucide="gift" class="section-icon"></i> Popular collections</h2></div><div class="collections-grid">${cards}</div>`;
    if (window.lucide) lucide.createIcons();
    el.querySelectorAll('.mini-thumb').forEach(t => t.onclick = () => openDetail(t.dataset.id));
    el.querySelectorAll('[data-cat]').forEach(btn => btn.onclick = () => {
      state.category = btn.dataset.cat;
      renderCategories();
      loadItems();
      document.querySelector('#content').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  } catch (e) { /* non-critical */ }
}

// Community Story — grounded in a real claimed item rather than a fabricated testimonial; falls back
// to an evergreen line when there's no claimed-item data yet (e.g. a brand-new deployment).
async function loadCommunityStory() {
  const el = $('#communitySection');
  if (!el) return;
  if (state.section !== 'consumer') { el.innerHTML = ''; return; }
  try {
    const items = await api('/api/items?listing_type=consumer');
    const claimed = items.filter(i => i.status === 'claimed');
    let quote, meta;
    if (claimed.length) {
      const pick = claimed[Math.floor(Date.now() / 86400000) % claimed.length];
      quote = `"${pick.title}" found a new home.`;
      meta = `Shared by ${pick.owner_name}${pick.owner_location ? ' in ' + pick.owner_location : ''}`;
    } else {
      quote = 'Every item posted here is one less thing in a landfill.';
      meta = 'Be the first to share a success story — post an item today.';
    }
    el.innerHTML = `<div class="community-story">
      <span class="quote-icon">❤️</span>
      <div class="story-body">
        <blockquote>${escapeHtml(quote)}</blockquote>
        <div class="story-meta">${escapeHtml(meta)}</div>
      </div>
      <button class="story-link" id="storyImpactLink">See our impact →</button>
    </div>`;
    $('#storyImpactLink').onclick = () => openImpactModal();
  } catch (e) { /* non-critical */ }
}

function loadBusinessTeaser() {
  const el = $('#businessTeaserSection');
  if (!el) return;
  if (state.section === 'business_waste') { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="business-teaser">
    <div class="business-teaser-copy">
      <h2><i data-lucide="factory" class="section-icon"></i> Have business surplus to give away?</h2>
      <p>Office furniture, equipment, electronics and packaging — or recurring byproducts like metal scrap, cow dung and used cooking oil. Connect with nearby businesses and farms instead of sending it to waste.</p>
    </div>
    <!-- Small decorative illustration (desktop only) — no real photo asset exists for this banner
         yet, so this is a simple inline SVG in the same restrained style as the rest of the site,
         not a stand-in for a missing real photo the way the hero art was. -->
    <div class="business-teaser-art" aria-hidden="true">
      <svg viewBox="0 0 120 100" xmlns="http://www.w3.org/2000/svg">
        <rect x="8" y="46" width="46" height="40" rx="4" fill="rgba(255,255,255,.14)"/>
        <path d="M8 46l23-14 23 14" fill="none" stroke="rgba(255,255,255,.35)" stroke-width="3" stroke-linejoin="round"/>
        <line x1="31" y1="46" x2="31" y2="86" stroke="rgba(255,255,255,.25)" stroke-width="2"/>
        <line x1="8" y1="66" x2="54" y2="66" stroke="rgba(255,255,255,.25)" stroke-width="2"/>
        <rect x="66" y="30" width="30" height="56" rx="6" fill="rgba(255,255,255,.1)"/>
        <circle cx="81" cy="46" r="9" fill="none" stroke="var(--pop)" stroke-width="3"/>
        <path d="M72 70h18M72 78h12" stroke="rgba(255,255,255,.3)" stroke-width="3" stroke-linecap="round"/>
      </svg>
    </div>
    <button class="btn-light" id="businessTeaserBtn">Explore Business Surplus</button>
  </div>`;
  $('#businessTeaserBtn').onclick = () => {
    document.querySelector('.section-tab[data-section="business_waste"]').click();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  if (window.lucide) lucide.createIcons();
}

// Compact sidebar Business Surplus card — additive to (not a replacement for) the larger
// #businessTeaserSection banner further down the page; same destination/action, just visible
// higher up the page alongside the marketplace content instead of only after the full grid.
function loadBusinessAsideCard() {
  const el = $('#businessAsideCard');
  if (!el) return;
  if (state.section === 'business_waste') { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="business-aside-card">
    <h3>🏭 Have business surplus to give away?</h3>
    <p>Office furniture, equipment, electronics, packaging and more. Help reduce waste and support the community.</p>
    <button type="button" class="btn-light" id="businessAsideBtn">Explore Business Surplus →</button>
  </div>`;
  $('#businessAsideBtn').onclick = () => {
    document.querySelector('.section-tab[data-section="business_waste"]').click();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
}

function activeCategoryList() {
  if (state.section === 'business_waste') return state.businessCategories;
  if (state.section === 'requests') return state.requestType === 'service' ? state.serviceCategories : state.categories;
  return state.categories;
}

async function refreshNotifCount() {
  if (!state.user) return;
  const { count } = await api('/api/notifications/unread-count');
  const dot = $('#notifDot');
  if (dot) dot.textContent = count > 0 ? String(count) : '';
  if (dot) dot.style.display = count > 0 ? '' : 'none';
  // Mirror the same unread state onto the mobile bottom-nav Profile tab (notifications now live
  // inside Profile on mobile — see bindBottomNav()) so the badge is visible without duplicating
  // the notification-count logic.
  const bnDot = $('#bottomNavProfileDot');
  if (bnDot) bnDot.style.display = count > 0 ? '' : 'none';
}

const TREND_TABS = [
  { key: 'hot', label: '🔥 Trending today' },
  { key: 'new', label: '🆕 Recently added' },
  { key: 'near', label: '📍 Near you' },
  { key: 'free', label: '♻️ Free items' }
];

async function loadTrending() {
  const el = $('#trendingSection');
  if (state.section === 'requests') { el.innerHTML = ''; return; }
  let hot = [];
  try { hot = await api('/api/items-trending?listing_type=' + state.section); } catch (e) { /* non-critical */ }
  if (!hot.length) {
    el.innerHTML = `<div class="trending-wrap">
      <div class="empty-state compact">
        <div class="empty-state-icon">🌱</div>
        <h3>Nothing has been posted yet</h3>
        <p>Be the first person to give something a new home.</p>
        <button class="primary-btn" id="trendingEmptyPostBtn">Post an item</button>
      </div>
    </div>`;
    const btn = $('#trendingEmptyPostBtn');
    if (btn) btn.onclick = () => $('#postBtn').click();
    return;
  }
  el.innerHTML = `<div class="trending-wrap">
    <h2><i data-lucide="flame" class="section-icon"></i> Trending near you</h2>
    <p class="highlight-sub">Popular items people are viewing and claiming nearby.</p>
    <div class="trend-tabs">${TREND_TABS.map((t, i) => `<button class="trend-tab${i === 0 ? ' active' : ''}" data-tab="${t.key}">${t.label}</button>`).join('')}</div>
    <div class="grid" id="trendGrid"></div>
  </div>`;
  el.querySelectorAll('.trend-tab').forEach(btn => btn.onclick = () => {
    el.querySelectorAll('.trend-tab').forEach(b => b.classList.toggle('active', b === btn));
    loadTrendTab(btn.dataset.tab);
  });
  if (window.lucide) lucide.createIcons();
  const grid = $('#trendGrid');
  // Homepage preview caps at 6 (matches the fixed 6-column desktop grid so the row is always
  // full, not dependent on however many items happen to have request_count > 0 right now).
  // "View all" still shows the complete trending set, unaffected.
  grid.innerHTML = hot.slice(0, 6).map(cardHtml).join('');
  grid.querySelectorAll('.card').forEach(c => c.onclick = () => openDetail(c.dataset.id));
  bindWishlistButtons(grid);
}

async function loadTrendTab(tab) {
  const grid = $('#trendGrid');
  if (!grid) return;
  let items = [];
  try {
    if (tab === 'hot') {
      items = (await api('/api/items-trending?listing_type=' + state.section)).slice(0, 6);
    } else if (tab === 'new') {
      items = (await api('/api/items?listing_type=' + state.section)).slice(0, 6);
    } else if (tab === 'near') {
      const loc = (state.user && state.user.location) || '';
      const params = new URLSearchParams({ listing_type: state.section });
      if (loc) params.set('location', loc);
      items = (await api('/api/items?' + params.toString())).slice(0, 6);
    } else if (tab === 'free') {
      items = (await api('/api/items?listing_type=' + state.section + '&price_type=free')).slice(0, 6);
    }
  } catch (e) { /* non-critical */ }
  if (!items.length) { grid.innerHTML = `<div class="empty">Nothing here yet.</div>`; return; }
  grid.innerHTML = items.map(cardHtml).join('');
  grid.querySelectorAll('.card').forEach(c => c.onclick = () => openDetail(c.dataset.id));
  bindWishlistButtons(grid);
}

function bindTopBar() {
  // Compact mobile Impact Tracker card's "View Full Impact" button — reuses the exact same
  // modal already wired to the nearby-activity and footer impact links, no new logic.
  $('#ecoViewFullBtn').onclick = () => openImpactModal();
  // Mobile-only Quick Actions row — reuses the exact same modal-opener functions the header
  // "+Post item" button and Requests-tab post button already call, no new posting logic.
  $('#quickPostItemBtn').onclick = () => { if (!state.user) return openAuthModal('login'); openPostModal(); };
  $('#quickPostRequestBtn').onclick = () => { if (!state.user) return openAuthModal('login'); openPostRequestModal(); };
  $('#postBtn').onclick = () => {
    if (!state.user) return openAuthModal('login');
    openPostSheet();
  };
  // heroPostBtn's click handler is wired per-slide by initHeroCarousel() instead of here,
  // since its label/action changes depending on which hero slide is currently active.
  $('#search').oninput = debounce(e => {
    state.q = e.target.value;
    state.section === 'requests' ? loadRequests() : loadItems();
  }, 350);
  $('#locationFilter').oninput = debounce(e => {
    state.location = e.target.value;
    state.section === 'requests' ? loadRequests() : loadItems();
    loadNearbyActivity();
  }, 350);
  $('#priceFilter').onchange = e => { state.priceType = e.target.value; loadItems(); };
  // Filters V1: a small revealed row (urgent-only + sort) rather than a full filter drawer —
  // works identically for items (ReUse/Food Rescue/Business Surplus) and Requests.
  $('#filtersBtn').onclick = () => {
    const panel = $('#filtersPanel');
    panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
  };
  $('#filterUrgent').onchange = e => {
    state.urgentOnly = e.target.checked;
    state.section === 'requests' ? loadRequests() : loadItems();
  };
  $('#filterSort').onchange = e => {
    state.sort = e.target.value;
    state.section === 'requests' ? loadRequests() : loadItems();
  };
  // Explicit "Search" button next to Filters — the input already live-filters via oninput above;
  // this just gives an obvious click target (matches the reference) and jumps straight to results.
  const heroSearchBtn = $('#heroSearchBtn');
  if (heroSearchBtn) heroSearchBtn.onclick = () => {
    state.q = $('#search').value;
    state.section === 'requests' ? loadRequests() : loadItems();
    document.querySelector('.page-layout')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  // Hero "Popular:" quick-category shortcuts — same category filter as the sidebar/quick-row,
  // just reachable straight from the hero.
  document.querySelectorAll('.hero-popular-link').forEach(btn => btn.onclick = () => {
    state.category = btn.dataset.cat;
    renderCategories();
    renderQuickCategories();
    loadItems();
    document.querySelector('.page-layout')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

// ---------- mobile bottom navigation + Post action sheet (nav redesign Stage 2) ----------
// Every action here routes to an existing function/handler — no new posting, browsing, or
// profile logic is introduced. Desktop is untouched: none of this markup is visible there
// (see .mobile-only-section / #bottomNav in styles.css).
function setBottomNavActive(key) {
  document.querySelectorAll('.bottom-nav-item').forEach(el => el.classList.toggle('active', el.dataset.bn === key));
}

// Mobile-only Home/Browse split. Pure CSS toggle (body.view-browse, scoped inside the existing
// max-width:600px media query) — desktop is never affected since it doesn't read state.view or
// the body class at all. No content is duplicated: Browse just reveals the same #categories
// sidebar + #content grid that already exist, Home just hides them in favor of the previews.
function setMobileView(view) {
  state.view = view;
  document.body.classList.toggle('view-browse', view === 'browse');
}

function openPostSheet() {
  $('#postSheetOverlay').style.display = 'flex';
}
function closePostSheet() {
  $('#postSheetOverlay').style.display = 'none';
}

function openProfileSheet() {
  if (!state.user) return openAuthModal('login');
  const notifLabel = ($('#notifDot') && $('#notifDot').style.display !== 'none') ? `Notifications (${$('#notifDot').textContent})` : 'Notifications';
  showModal(`
    <h2>Profile</h2>
    <p class="hint" style="margin-top:-4px">Hi, ${escapeHtml(state.user.name)} ${state.user.account_type === 'business' ? '🏢' : ''}</p>
    <div class="profile-sheet-list">
      <button type="button" class="profile-sheet-item" id="profileSheetNotif">🔔 ${notifLabel}</button>
      <button type="button" class="profile-sheet-item" id="profileSheetMyPosts">📦 My posts</button>
      <button type="button" class="profile-sheet-item" id="profileSheetActivity">📋 Activity</button>
      ${state.user.is_admin ? '<button type="button" class="profile-sheet-item" id="profileSheetAdmin">🛡️ Admin</button>' : ''}
      <button type="button" class="profile-sheet-item danger" id="profileSheetLogout">🚪 Log out</button>
    </div>
  `);
  $('#profileSheetNotif').onclick = () => { closeModal(); toggleNotifPanel(); };
  $('#profileSheetMyPosts').onclick = () => { closeModal(); openMyPosts(); };
  $('#profileSheetActivity').onclick = () => { closeModal(); openActivity(); };
  if (state.user.is_admin) $('#profileSheetAdmin').onclick = () => { closeModal(); openAdminDashboard(); };
  $('#profileSheetLogout').onclick = async () => { closeModal(); await api('/api/logout', { method: 'POST' }); state.user = null; renderNav(); loadItems(); };
}

function bindBottomNav() {
  const bottomNav = $('#bottomNav');
  if (!bottomNav) return;

  $('#bnHomeBtn').onclick = () => {
    const consumerTab = document.querySelector('.section-tab[data-section="consumer"]');
    if (consumerTab && !consumerTab.classList.contains('active')) consumerTab.click();
    setMobileView('home');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    setBottomNavActive('home');
  };
  $('#bnBrowseBtn').onclick = () => {
    const consumerTab = document.querySelector('.section-tab[data-section="consumer"]');
    if (consumerTab && !consumerTab.classList.contains('active')) consumerTab.click();
    setMobileView('browse');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    setBottomNavActive('browse');
  };
  $('#bnRequestsBtn').onclick = () => {
    const tab = document.querySelector('.section-tab[data-section="requests"]');
    if (tab) tab.click();
    // Requests needs the categories/listing area visible (same as Browse), just highlighted
    // as its own bottom-nav tab rather than "Browse".
    setMobileView('browse');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    setBottomNavActive('requests');
  };
  $('#bnProfileBtn').onclick = () => { openProfileSheet(); };
  $('#bnPostBtn').onclick = () => openPostSheet();

  $('#postSheetOverlay').onclick = (e) => { if (e.target.id === 'postSheetOverlay') closePostSheet(); };
  $('#sheetCancelBtn').onclick = () => closePostSheet();
  $('#sheetPostItemBtn').onclick = () => {
    closePostSheet();
    if (!state.user) return openAuthModal('login');
    const tab = document.querySelector('.section-tab[data-section="consumer"]');
    if (tab) tab.click();
    openPostModal();
  };
  $('#sheetPostItemRequestBtn').onclick = () => {
    closePostSheet();
    if (!state.user) return openAuthModal('login');
    const tab = document.querySelector('.section-tab[data-section="requests"]');
    if (tab) tab.click();
    state.requestType = 'thing';
    openPostRequestModal();
  };
  $('#sheetPostServiceRequestBtn').onclick = () => {
    closePostSheet();
    if (!state.user) return openAuthModal('login');
    const tab = document.querySelector('.section-tab[data-section="requests"]');
    if (tab) tab.click();
    state.requestType = 'service';
    openPostRequestModal();
  };
  $('#sheetPostBusinessBtn').onclick = () => {
    closePostSheet();
    if (!state.user) return openAuthModal('login');
    const tab = document.querySelector('.section-tab[data-section="business_waste"]');
    if (tab) tab.click();
    openPostModal();
  };
}

// ---------- More/Community menu content (shared by desktop dropdown + mobile bottom sheet) ----------
// Every item here jumps to a section that already exists on the page, or opens an existing modal
// (openImpactModal) — no new pages/content, no fake/placeholder items (no Saved Searches, no Help
// Center — neither exists yet, so neither is listed).
const MORE_MENU_GROUPS = [
  { label: 'Discover', items: [
    { key: 'categories', icon: 'layout-grid', label: 'Categories' },
    { key: 'nearby', icon: 'map-pin', label: 'Nearby' },
    { key: 'filters', icon: 'sliders-horizontal', label: 'Filters' },
    { key: 'champions', icon: 'trophy', label: 'Monthly Champions' }
  ]},
  { label: 'Community', items: [
    { key: 'community', icon: 'users', label: 'Community Stats' },
    { key: 'requests', icon: 'hand-heart', label: 'Requests' },
    { key: 'trust', icon: 'shield-check', label: 'Trust & Safety' }
  ]},
  { label: 'Business', items: [
    { key: 'business', icon: 'building-2', label: 'Business Surplus', badge: true }
  ]},
  { label: 'About', items: [
    { key: 'about', icon: 'info', label: 'About ReUse Hub' }
  ]}
];
function moreMenuItemsHtml() {
  const groups = MORE_MENU_GROUPS.map(g => `
    <div class="more-menu-group">
      <div class="more-menu-group-label">${escapeHtml(g.label)}</div>
      ${g.items.map(it => `<button type="button" role="menuitem" data-more="${it.key}"><i data-lucide="${it.icon}"></i> ${escapeHtml(it.label)}${it.badge ? ' <span class="new-badge">NEW</span>' : ''}</button>`).join('')}
    </div>
  `).join('');
  // Highlighted footer CTA — same destination as the "impact" item above (openImpactModal), just
  // given its own visual weight since Impact is one of ReUse Hub's differentiators.
  const impactCta = `
    <button type="button" class="more-menu-impact-cta" data-more="impact">
      <span class="more-menu-impact-icon"><i data-lucide="leaf"></i></span>
      <span class="more-menu-impact-text"><strong>Our Impact</strong><small>See how we're making a difference</small></span>
      <i data-lucide="chevron-right"></i>
    </button>
  `;
  return `<div class="more-menu-groups">${groups}</div>${impactCta}`;
}
const scrollToSel = (sel) => { const el = document.querySelector(sel); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
const MORE_ACTIONS = {
  categories: () => scrollToSel('.page-layout'),
  business: () => { const tab = document.querySelector('.section-tab[data-section="business_waste"]'); if (tab) tab.click(); window.scrollTo({ top: 0, behavior: 'smooth' }); },
  nearby: () => scrollToSel('#nearbySection'),
  filters: () => { scrollToSel('.hero-banner'); const panel = $('#filtersPanel'); if (panel) panel.style.display = 'flex'; },
  urgent: () => scrollToSel('#urgentSection'),
  champions: () => scrollToSel('#championsSection'),
  impact: () => openImpactModal(),
  community: () => scrollToSel('#communitySection'),
  requests: () => { const tab = document.querySelector('.section-tab[data-section="requests"]'); if (tab) tab.click(); window.scrollTo({ top: 0, behavior: 'smooth' }); },
  trust: () => scrollToSel('.trust-strip'),
  about: () => scrollToSel('footer')
};

// ---------- desktop More/Community menu (nav redesign Stage 4) ----------
function bindMoreMenu() {
  const wrap = $('#moreMenuWrap');
  if (!wrap) return;
  const btn = $('#moreMenuBtn');
  const dropdown = $('#moreMenuDropdown');
  dropdown.innerHTML = moreMenuItemsHtml();
  const closeDropdown = () => { dropdown.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); };
  const openDropdown = () => { dropdown.classList.add('open'); btn.setAttribute('aria-expanded', 'true'); };
  btn.onclick = (e) => { e.stopPropagation(); dropdown.classList.contains('open') ? closeDropdown() : openDropdown(); };
  document.addEventListener('click', (e) => { if (!e.target.closest('#moreMenuWrap')) closeDropdown(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && dropdown.classList.contains('open')) { closeDropdown(); btn.focus(); } });
  dropdown.querySelectorAll('[data-more]').forEach(item => {
    item.onclick = () => { const fn = MORE_ACTIONS[item.dataset.more]; if (fn) fn(); closeDropdown(); };
  });
  if (window.lucide) lucide.createIcons();
}

// ---------- mobile combined More menu (one bottom sheet, same content as the desktop dropdown —
// no separate/duplicate drawers) ----------
function bindMobileMoreMenu() {
  const openBtn = $('#mobileMoreBtn');
  const overlay = $('#mobileMoreSheetOverlay');
  const list = $('#mobileMoreList');
  if (!openBtn || !overlay || !list) return;
  list.innerHTML = moreMenuItemsHtml();
  const close = () => { overlay.style.display = 'none'; };
  const open = () => { overlay.style.display = 'flex'; };
  openBtn.onclick = () => open();
  overlay.onclick = (e) => { if (e.target.id === 'mobileMoreSheetOverlay') close(); };
  $('#mobileMoreCancelBtn').onclick = () => close();
  list.querySelectorAll('[data-more]').forEach(item => {
    item.onclick = () => { const fn = MORE_ACTIONS[item.dataset.more]; if (fn) fn(); close(); };
  });
  if (window.lucide) lucide.createIcons();
}

function renderVerifyBanner() {
  const el = $('#verifyBanner');
  if (!el) return;
  if (!state.user || state.user.is_verified) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="verify-banner">
    <span>✅ Get verified to build trust.</span>
    <button id="startVerifyBtn">Verify now</button>
  </div>`;
  $('#startVerifyBtn').onclick = () => openVerifyModal();
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// Header account cluster (avatar + name + chevron) opens a small dropdown for Log out (and Admin,
// for admins) instead of a permanently-visible "Log out" pill — My posts/Activity/notifications
// stay directly visible/lightweight. The trailing "⋮" overflow control opens the same dropdown
// (not a second, different menu) — a real, functioning shortcut rather than a decorative icon.
function renderNav() {
  const nav = $('#nav');
  if (state.user) {
    const initial = escapeHtml((state.user.name || '?').trim().charAt(0).toUpperCase());
    nav.innerHTML = `
      <button type="button" id="myItemsBtn" class="nav-icon-link"><i data-lucide="package"></i> My posts</button>
      <button type="button" id="activityBtn" class="nav-icon-link"><i data-lucide="activity"></i> Activity</button>
      <div class="notif-wrap" id="notifWrap">
        <button class="notif-btn" id="notifBtn" aria-label="Notifications"><i data-lucide="bell"></i><span class="notif-dot" id="notifDot" style="display:none"></span></button>
        <div class="notif-panel" id="notifPanel" style="display:none"></div>
      </div>
      <div class="user-menu-wrap" id="userMenuWrap">
        <button type="button" class="user-chip" id="userChipBtn" aria-haspopup="true" aria-expanded="false">
          <span class="user-avatar">${initial}</span>
          <span class="user-chip-label">Hi, ${escapeHtml(state.user.name)}${state.user.account_type === 'business' ? ' 🏢' : ''}</span>
          <i data-lucide="chevron-down"></i>
        </button>
        <div class="user-menu-dropdown" id="userMenuDropdown" role="menu">
          ${state.user.is_admin ? '<button type="button" role="menuitem" id="adminBtn"><i data-lucide="shield"></i> Admin</button>' : ''}
          <button type="button" role="menuitem" id="logoutBtn" class="danger"><i data-lucide="log-out"></i> Log out</button>
        </div>
      </div>
      <button type="button" class="header-overflow-btn" id="headerOverflowBtn" aria-label="More account options"><i data-lucide="more-vertical"></i></button>`;
    $('#notifBtn').onclick = (e) => { e.stopPropagation(); toggleNotifPanel(); };
    $('#myItemsBtn').onclick = () => openMyPosts();
    $('#activityBtn').onclick = () => openActivity();
    const userDropdown = $('#userMenuDropdown');
    const userChipBtn = $('#userChipBtn');
    const closeUserMenu = () => { userDropdown.classList.remove('open'); userChipBtn.setAttribute('aria-expanded', 'false'); };
    const toggleUserMenu = (e) => {
      e.stopPropagation();
      const willOpen = !userDropdown.classList.contains('open');
      userDropdown.classList.toggle('open', willOpen);
      userChipBtn.setAttribute('aria-expanded', String(willOpen));
    };
    userChipBtn.onclick = toggleUserMenu;
    $('#headerOverflowBtn').onclick = toggleUserMenu;
    document.addEventListener('click', (e) => { if (!e.target.closest('#userMenuWrap')) closeUserMenu(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeUserMenu(); });
    if (state.user.is_admin) $('#adminBtn').onclick = () => { closeUserMenu(); openAdminDashboard(); };
    $('#logoutBtn').onclick = async () => { closeUserMenu(); await api('/api/logout', { method: 'POST' }); state.user = null; renderNav(); loadItems(); };
    refreshNotifCount();
  } else {
    nav.innerHTML = `<button id="loginBtn">Log in</button><button id="signupBtn">Sign up</button>`;
    $('#loginBtn').onclick = () => openAuthModal('login');
    $('#signupBtn').onclick = () => openAuthModal('signup');
  }
  if (window.lucide) lucide.createIcons();
  renderVerifyBanner();
}

// Monochrome (single-color, Lucide) icon set — replaces the earlier multicolor emoji set for a more premium look.
const CATEGORY_ICONS = {
  'Education & School Supplies': 'graduation-cap', 'Baby & Kids': 'baby', 'Books & Media': 'book-open',
  'Construction Materials': 'hard-hat', 'Electronics & Phones': 'smartphone', 'Computers & Laptops': 'laptop', 'Furniture': 'sofa',
  'Vehicles': 'car', 'Clothing & Accessories': 'shirt', 'Kitchen & Appliances': 'utensils', 'Food (Surplus)': 'apple',
  'Tools & Equipment': 'wrench', 'Event Items & Decorations': 'party-popper', 'Other': 'package',
  // legacy category names (pre category-cleanup) — kept only so any raw/unmapped display of an
  // old stored value still resolves an icon instead of falling back to the generic package icon.
  'Toys & Kids': 'baby', 'Baby Products': 'baby',
  // service categories
  'Electrician': 'zap', 'Plumber': 'wrench', 'Tutor': 'graduation-cap', 'Delivery': 'truck', 'Cleaning': 'sparkles',
  'Repairs': 'hammer', 'Design': 'pen-tool', 'Photography': 'camera', 'Pet Care': 'dog', 'Other Service': 'package',
  // business categories
  'Metal Scrap (CNC/Machining)': 'cog', 'Wood Scrap & Sawdust': 'axe', 'Cow Dung & Manure': 'leaf',
  'Used Cooking Oil': 'droplet', 'Food & Organic Waste': 'apple', 'Fabric & Textile Scrap': 'shirt',
  'Paper & Cardboard Waste': 'file-text', 'Plastic Scrap': 'recycle', 'Construction Debris': 'hard-hat',
  'Other Industrial Byproduct': 'package'
};

// Category-merge compatibility (mirrors server.js LEGACY_CATEGORY_MERGE): items/requests posted
// before the category cleanup may still carry the old 'Baby Products'/'Toys & Kids' values in the
// database (never rewritten). Wherever a stored category is shown as text to the user, or matched
// against the current canonical dropdown options, run it through this map first.
const LEGACY_CATEGORY_LABELS = { 'Baby Products': 'Baby & Kids', 'Toys & Kids': 'Baby & Kids' };
function displayCategory(cat) { return LEGACY_CATEGORY_LABELS[cat] || cat; }

// Rotating background colors for the quick-category icon row (visual only — purely decorative,
// doesn't affect which category a click actually applies).
// Quick category rail — one unified soft-tint icon treatment (no per-category rainbow colors),
// matches the same green/neutral palette used everywhere else. "More" is styled identically to
// every other item (no separate button chrome) and just scrolls to the existing full category
// sidebar — same underlying state.category / renderCategories() / loadItems() logic as before.
const QUICK_CAT_VISIBLE = 6;
function renderQuickCategories() {
  const row = $('#quickCategoriesRow');
  if (!row) return;
  if (state.section !== 'consumer') { row.innerHTML = ''; return; }
  const all = activeCategoryList();
  const cats = all.slice(0, QUICK_CAT_VISIBLE);
  const hasMore = all.length > QUICK_CAT_VISIBLE;
  row.innerHTML = cats.map(c => `
    <button type="button" class="quick-cat-btn${state.category === c ? ' active' : ''}" data-c="${escapeHtml(c)}">
      <span class="quick-cat-icon"><i data-lucide="${CATEGORY_ICONS[c] || 'package'}"></i></span>
      <span class="quick-cat-label">${escapeHtml(c)}</span>
    </button>
  `).join('') + (hasMore ? `
    <button type="button" class="quick-cat-btn quick-cat-more" id="quickCatMoreBtn">
      <span class="quick-cat-icon"><i data-lucide="more-horizontal"></i></span>
      <span class="quick-cat-label">More</span>
    </button>
  ` : '');
  row.querySelectorAll('.quick-cat-btn:not(.quick-cat-more)').forEach(btn => btn.onclick = () => {
    state.category = btn.dataset.c;
    renderCategories();
    renderQuickCategories();
    loadItems();
    document.querySelector('.page-layout')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  const moreBtn = $('#quickCatMoreBtn');
  if (moreBtn) moreBtn.onclick = () => {
    document.querySelector('.sidebar')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  if (window.lucide) lucide.createIcons();
}

function renderCategories() {
  const wrap = $('#categories');
  wrap.innerHTML = `<span class="chip ${state.category === '' ? 'active' : ''}" data-c=""><span class="cat-icon"><i data-lucide="layout-grid"></i></span>All</span>` +
    activeCategoryList().map(c => `<span class="chip ${state.category === c ? 'active' : ''}" data-c="${escapeHtml(c)}"><span class="cat-icon"><i data-lucide="${CATEGORY_ICONS[c] || 'package'}"></i></span>${escapeHtml(c)}</span>`).join('');
  wrap.querySelectorAll('.chip').forEach(el => el.onclick = () => {
    state.category = el.dataset.c;
    renderCategories();
    state.section === 'requests' ? loadRequests() : loadItems();
  });
  if (window.lucide) lucide.createIcons();
}

async function loadEcoPanel() {
  const el = $('#ecoStats');
  if (el) {
    try {
      const stats = await api('/api/impact');
      const rows = [
        { n: stats.reused_items || 0, label: 'Items reused' },
        { n: stats.total_users || 0, label: 'Active members' },
        { n: stats.completed_requests || 0, label: 'Happy exchanges' }
      ];
      el.innerHTML = rows.map((s, i) => `<div class="eco-stat"><span class="num" id="ecoNum${i}">0</span><span class="label">${s.label}</span></div>`).join('');
      rows.forEach((s, i) => animateCount($('#ecoNum' + i), s.n));

      // Extra estimated-impact metrics — simple, clearly-labeled multipliers on real counts from /api/impact.
      const extraEl = $('#ecoExtra');
      if (extraEl) {
        const reused = stats.reused_items || 0;
        const extraRows = [
          { n: Math.round(reused * 4.2), label: 'Est. CO₂ saved (kg)' },
          { n: Math.round(reused / 15) || (reused > 0 ? 1 : 0), label: 'Est. trees saved' },
          { n: stats.waste_diverted_listings || 0, label: 'Waste streams diverted' },
          { n: stats.repeat_users || 0, label: 'Repeat community members' }
        ];
        extraEl.innerHTML = `<div class="eco-panel-section"><h4><i data-lucide="sparkles"></i> Estimated impact</h4>
          ${extraRows.map((s, i) => `<div class="eco-mini-row"><span class="t">${s.label}</span><span class="v" id="ecoExtraNum${i}">0</span></div>`).join('')}
        </div>`;
        extraRows.forEach((s, i) => animateCount($('#ecoExtraNum' + i), s.n, 1100));
        if (window.lucide) lucide.createIcons();
      }
    } catch (e) { /* impact panel is non-critical, fail quietly */ }
  }

  // Nearby requests mini-list — real open requests, filtered by the logged-in user's location when known.
  const nearbyEl = $('#ecoNearby');
  if (nearbyEl) {
    try {
      const loc = (state.user && state.user.location) || '';
      const params = new URLSearchParams({ request_type: 'thing' });
      if (loc) params.set('location', loc);
      const open = (await api('/api/requests?' + params.toString())).slice(0, 3);
      nearbyEl.innerHTML = `<div class="eco-panel-section"><h4><i data-lucide="map-pin"></i> Nearby requests</h4>
        ${open.length ? open.map(r => `<div class="eco-mini-row" data-id="${r.id}"><span class="t">${escapeHtml(r.title)}</span><span class="v">${r.is_urgent ? '🚨' : '→'}</span></div>`).join('') : `<div class="eco-mini-empty">No open requests right now.</div>`}
      </div>`;
      nearbyEl.querySelectorAll('.eco-mini-row[data-id]').forEach(row => row.onclick = () => openRequestDetail(row.dataset.id));
      if (window.lucide) lucide.createIcons();
    } catch (e) { /* non-critical */ }
  }
}

// ---------- Nearby Activity (homepage) ----------
function timeAgo(dateStr) {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return min + ' min ago';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + (hr === 1 ? ' hour ago' : ' hours ago');
  const day = Math.floor(hr / 24);
  return day + (day === 1 ? ' day ago' : ' days ago');
}

const NEARBY_ICONS = { consumer: '🪑', business_waste: '📦', thing: '🪑', service: '🤝' };

async function loadNearbyActivity() {
  const countsEl = $('#nearbyCounts');
  const recentEl = $('#nearbyRecent');
  if (!countsEl || !recentEl) return;
  try {
    const loc = state.location || '';
    const q = loc ? '&location=' + encodeURIComponent(loc) : '';
    const [consumerItems, bizItems, thingReqs, serviceReqs] = await Promise.all([
      api('/api/items?listing_type=consumer' + q),
      api('/api/items?listing_type=business_waste' + q),
      api('/api/requests?request_type=thing' + q),
      api('/api/requests?request_type=service' + q)
    ]);
    const allItems = [...consumerItems, ...bizItems];
    const allRequests = [...thingReqs, ...serviceReqs];

    countsEl.innerHTML = `
      <div class="nearby-count"><strong>${allItems.length}</strong> item${allItems.length === 1 ? '' : 's'} nearby</div>
      <div class="nearby-count"><strong>${allRequests.length}</strong> request${allRequests.length === 1 ? '' : 's'} nearby</div>
    `;

    const feed = [
      ...allItems.map(i => ({ type: 'item', icon: NEARBY_ICONS[i.listing_type] || '🪑', title: i.title, loc: i.owner_location, at: i.created_at, id: i.id })),
      ...allRequests.map(r => ({ type: 'request', icon: NEARBY_ICONS[r.request_type] || '🙋', title: r.title, loc: r.owner_location, at: r.created_at, id: r.id }))
    ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 3);

    if (!feed.length) {
      recentEl.innerHTML = `<div class="nearby-empty">Nothing new nearby yet. Be the first to post.</div>`;
    } else {
      recentEl.innerHTML = feed.map(f => `
        <div class="nearby-row" data-type="${f.type}" data-id="${f.id}">
          <span class="nearby-row-icon">${f.icon}</span>
          <span class="nearby-row-text">
            <span class="nearby-row-title">${escapeHtml(f.title)}</span>
            <span class="nearby-row-meta">${escapeHtml(f.loc || 'Nearby')} · ${timeAgo(f.at)}</span>
          </span>
        </div>
      `).join('');
      recentEl.querySelectorAll('.nearby-row').forEach(row => {
        row.onclick = () => row.dataset.type === 'item' ? openDetail(row.dataset.id) : openRequestDetail(row.dataset.id);
      });
    }
  } catch (e) { /* non-critical */ }
}

function bindNearbySection() {
  const btn = $('#nearbyCtaBtn');
  if (!btn) return;
  btn.onclick = () => {
    const locInput = $('#locationFilter');
    if (locInput && locInput.value.trim()) {
      $('#content')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      document.querySelector('.hero-banner')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setTimeout(() => locInput && locInput.focus(), 400);
    }
  };
}

// ---------- monthly contribution badges (Community Champions) ----------
// No points/XP/levels — just real completed-exchange counts, fetched live every load so it
// naturally changes when the month changes rather than being permanently awarded.
async function loadMonthlyBadges() {
  const el = $('#championsSection');
  if (!el) return;
  try {
    const badges = await api('/api/badges/monthly');
    state.monthlyBadges = badges;
    el.innerHTML = championsSectionHtml(badges);
    const btn = $('#viewAllContributorsBtn');
    if (btn) btn.onclick = () => openContributorsModal();
    if (window.lucide) lucide.createIcons();
  } catch (e) { /* non-critical */ }
}

// Icons are Lucide (one family, one stroke) instead of medal/food emoji — the theme-* class on
// .champion-box (already gold/silver/bronze tinted) is what carries the rank meaning now, via
// the champion-rank-icon's color, rather than a 🥇🥈🥉 glyph.
const CHAMPION_KINDS = [
  { key: 'food_giver', theme: 'gold', icon: 'soup', title: 'Top Food Giver', emptyMsg: 'Be the first to rescue surplus food this month.' },
  { key: 'reuse_donor', theme: 'silver', icon: 'recycle', title: 'Top Reuse Donor', emptyMsg: 'Be the first to give an item a second life this month.' },
  { key: 'community_champion', theme: 'bronze', icon: 'sprout', title: 'Community Champion', emptyMsg: 'Start making an impact today and inspire others.' }
];

function championBoxHtml(kind, entry) {
  return `<div class="champion-box theme-${kind.theme}">
    <div class="champion-rank"><i data-lucide="award" class="champion-rank-icon"></i></div>
    <div class="champion-icon-wrap"><i data-lucide="${kind.icon}" class="champion-icon"></i></div>
    <div class="champion-title">${kind.title}</div>
    <div class="champion-name">${entry ? escapeHtml(entry.name) + (entry.account_type === 'business' ? ' <span class="owner-badge">Business</span>' : '') : 'No champion yet'}</div>
    <div class="champion-sub">${entry ? `${entry.count} completed this month` : kind.emptyMsg}</div>
    <div class="champion-footer">${entry ? entry.count : 0} confirmed donation${entry && entry.count === 1 ? '' : 's'}</div>
  </div>`;
}

function championsSectionHtml(badges) {
  return `
    <div class="champions-top">
      <div>
        <div class="champions-head"><i data-lucide="trophy" class="section-icon"></i> Monthly Community Champions</div>
        <div class="champions-sub">Recognizing the people making the biggest impact this month.</div>
      </div>
      <div class="champions-month"><i data-lucide="calendar" style="width:13px;height:13px"></i> ${escapeHtml(badges.month)}</div>
    </div>
    <div class="champions-grid">
      ${CHAMPION_KINDS.map(k => championBoxHtml(k, badges[k.key])).join('')}
    </div>
    <div class="champions-view-all-wrap">
      <button type="button" class="champions-view-all" id="viewAllContributorsBtn">View all contributors →</button>
    </div>`;
}

async function openContributorsModal() {
  showModal(`<h2><i data-lucide="trophy" class="section-icon"></i> Contributors this month</h2><div id="contributorsList">Loading...</div>`);
  if (window.lucide) lucide.createIcons();
  try {
    const badges = await api('/api/badges/monthly');
    const list = badges.leaderboard || [];
    $('#contributorsList').innerHTML = list.length
      ? `<div class="contributors-list">${list.map((c, i) => `
          <div class="contributor-row">
            <span class="contributor-rank">#${i + 1}</span>
            <span class="contributor-name">${escapeHtml(c.name)}${c.account_type === 'business' ? ' <span class="owner-badge">Business</span>' : ''}</span>
            <span class="contributor-count">${c.count} completed</span>
          </div>`).join('')}</div>`
      : `<div class="empty">Be the first community champion this month.</div>`;
  } catch (e) { $('#contributorsList').innerHTML = `<div class="empty">Couldn't load contributors right now.</div>`; }
}

async function loadItems() {
  const params = new URLSearchParams();
  params.set('listing_type', state.section);
  if (state.category) params.set('category', state.category);
  if (state.priceType) params.set('price_type', state.priceType);
  if (state.q) params.set('q', state.q);
  if (state.location) params.set('location', state.location);
  if (state.urgentOnly) params.set('urgent', '1');
  if (state.sort) params.set('sort', state.sort);
  const items = await api('/api/items?' + params.toString());
  state.items = items;
  renderGrid();
}

async function loadRequests() {
  const params = new URLSearchParams();
  params.set('request_type', state.requestType);
  if (state.category) params.set('category', state.category);
  if (state.q) params.set('q', state.q);
  if (state.urgentOnly) params.set('urgent', '1');
  if (state.location) params.set('location', state.location);
  if (state.sort) params.set('sort', state.sort);
  const requests = await api('/api/requests?' + params.toString());
  state.requests = requests;
  renderGrid();
}

const CONTENT_TITLES = {
  consumer: '🌱 Give items a new home',
  business_waste: '🏪 Business Surplus',
  requests: '🙋 Community requests'
};

function renderGrid() {
  const el = $('#content');
  const title = `<h2 class="content-title">${CONTENT_TITLES[state.section] || ''}</h2>`;
  if (state.section === 'requests') {
    if (!state.requests.length) {
      el.innerHTML = title + `<div class="empty-state compact">
        <div class="empty-state-icon">🙋</div>
        <h3>No requests yet</h3>
        <p>Ask your neighbors for something you need, or offer to help with one nearby.</p>
        <button class="primary-btn" id="gridEmptyPostBtn">Post a request</button>
      </div>`;
      const btn = $('#gridEmptyPostBtn'); if (btn) btn.onclick = () => $('#postBtn').click();
      return;
    }
    el.innerHTML = title + `<div class="grid">${state.requests.map(requestCardHtml).join('')}</div>`;
    el.querySelectorAll('.card').forEach(c => c.onclick = () => openRequestDetail(c.dataset.id));
    return;
  }
  if (!state.items.length) {
    el.innerHTML = title + `<div class="empty-state compact">
      <div class="empty-state-icon">🌱</div>
      <h3>Nothing has been posted yet</h3>
      <p>Be the first person to give something a new home.</p>
      <button class="primary-btn" id="gridEmptyPostBtn">Post an item</button>
    </div>`;
    const btn = $('#gridEmptyPostBtn'); if (btn) btn.onclick = () => $('#postBtn').click();
    return;
  }
  el.innerHTML = title + `<div class="grid">${state.items.map(cardHtml).join('')}</div>`;
  el.querySelectorAll('.card').forEach(c => c.onclick = () => openDetail(c.dataset.id));
  bindWishlistButtons(el);
}

function requestBadgeHtml(r) {
  let label;
  if (r.budget_type === 'paid') label = 'Will pay ₹' + r.budget_amount;
  else if (r.budget_type === 'exchange') label = 'Will exchange';
  else label = 'FREE HELP OK';
  let b = `<span class="badge ${r.budget_type}">${label}</span> <span class="badge ${r.request_type}">${r.request_type === 'service' ? '🔧 Service' : '📦 Item'}</span>`;
  if (r.is_urgent) b += ` <span class="badge urgent">Urgent</span>`;
  if (r.status === 'fulfilled') b += ` <span class="badge claimed">fulfilled</span>`;
  return b;
}

function requestPriceLabel(r) {
  if (r.is_urgent) return r.budget_type === 'paid' ? `Urgent · ₹${r.budget_amount}` : 'Urgent';
  if (r.budget_type === 'paid') return '₹' + r.budget_amount;
  if (r.budget_type === 'exchange') return 'Exchange';
  return 'Free help ok';
}

const LOC_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>`;
const PACKAGE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/></svg>`;
const HEART_SVG = `<svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8Z"/></svg>`;
const CHECK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
function ownerNameHtml(name, verified, ownerId) {
  // Clicking a name opens that user's public profile (see the delegated .owner-name-link handler
  // in init()) without affecting the rest of the card's own click target (openDetail etc.) — the
  // handler calls stopPropagation so this never double-fires the parent card's onclick.
  const inner = `${escapeHtml(name)}${verified ? `<span class="owner-check" title="Verified">${CHECK_SVG}</span>` : ''}${miniBadgeHtml(ownerId)}`;
  return ownerId
    ? `<button type="button" class="owner-name owner-name-link" data-uid="${escapeHtml(ownerId)}">${inner}</button>`
    : `<span class="owner-name">${inner}</span>`;
}

// Small badge shown beside a name when that user currently holds a monthly contribution badge —
// real data only, and it naturally changes/disappears when the month changes since it's always
// re-fetched from the live /api/badges/monthly calculation.
function miniBadgeHtml(ownerId) {
  if (!ownerId || !state.monthlyBadges) return '';
  const b = state.monthlyBadges;
  if (b.food_giver && b.food_giver.user_id === ownerId) return ` <span class="mini-badge" title="Top Food Giver · ${escapeHtml(b.month)}">🍲</span>`;
  if (b.reuse_donor && b.reuse_donor.user_id === ownerId) return ` <span class="mini-badge" title="Top Reuse Donor · ${escapeHtml(b.month)}">♻️</span>`;
  if (b.community_champion && b.community_champion.user_id === ownerId) return ` <span class="mini-badge" title="Community Champion · ${escapeHtml(b.month)}">🌱</span>`;
  return '';
}

function requestCardHtml(r) {
  const icon = r.request_type === 'service' ? '🛠️' : '🔎';
  const badgeCls = r.is_urgent ? 'price-badge urgent' : 'price-badge';
  const label = r.status === 'fulfilled' ? 'Fulfilled' : requestPriceLabel(r);
  return `<div class="card" data-id="${r.id}">
    <div class="thumb">
      <span class="thumb-emoji">${icon}</span>
      <span class="${badgeCls}">${label}</span>
    </div>
    <div class="body">
      <h3>${escapeHtml(r.title)}</h3>
      <div class="meta">${ownerNameHtml(r.owner_name, r.owner_verified, r.user_id)} • ${escapeHtml(displayCategory(r.category))}</div>
      <div class="footer-bar">
        <span class="loc">${LOC_SVG}${escapeHtml(r.owner_location || 'Nearby')}</span>
        <span class="go-btn">${r.request_type === 'service' ? 'Offer help' : 'Respond'} →</span>
      </div>
    </div>
  </div>`;
}

const FOOD_PREF_LABELS = { vegetarian: '🥦 Vegetarian', non_vegetarian: '🍗 Non-vegetarian', mixed: '🍽️ Mixed', not_specified: '' };

function badgeHtml(item) {
  let label;
  if (item.price_type === 'paid') label = '₹' + item.price;
  else if (item.price_type === 'rent') label = `₹${item.rent_rate}/${item.rent_period || 'day'}`;
  else label = item.price_type.toUpperCase();
  let b = `<span class="badge ${item.price_type}">${label}</span>`;
  if (item.is_recurring) b += ` <span class="badge recurring">${item.frequency || 'recurring'}</span>`;
  if (item.status === 'claimed') b += ` <span class="badge claimed">claimed</span>`;
  if (item.pickup_available) b += ` <span class="pickup-badge">🚚 Pickup available</span>`;
  if (item.is_urgent) b += ` <span class="badge urgent">🔥 Urgent</span>`;
  if (item.food_pref && FOOD_PREF_LABELS[item.food_pref]) b += ` <span class="badge food-pref">${FOOD_PREF_LABELS[item.food_pref]}</span>`;
  return b;
}

function thumbInnerHtml(item) {
  const first = (item.media && item.media[0]) || (item.media_url ? { url: item.media_url, media_type: item.media_type } : null);
  if (!first) return `<span class="thumb-emoji">📦</span>`;
  if (first.media_type === 'video') return `<video src="${first.url}" muted></video>`;
  return `<img src="${first.url}" loading="lazy">`;
}

function itemPriceLabel(item) {
  if (item.status === 'claimed') return 'Claimed';
  if (item.price_type === 'paid') return '₹' + item.price;
  if (item.price_type === 'rent') return `₹${item.rent_rate}/${item.rent_period || 'day'}`;
  if (item.price_type === 'exchange') return 'Exchange';
  return 'Free';
}

function pickupFlagHtml(item) {
  if (!item.pickup_available) return '';
  return `<span class="pickup-flag">${PACKAGE_SVG}Pickup</span>`;
}

function galleryHtml(item) {
  const media = (item.media && item.media.length) ? item.media : (item.media_url ? [{ url: item.media_url, media_type: item.media_type }] : []);
  if (!media.length) return '';
  return `<div class="gallery">${media.map(m => m.media_type === 'video'
    ? `<video src="${m.url}" controls></video>`
    : `<img src="${m.url}">`).join('')}</div>`;
}

// Formats available_until ("YYYY-MM-DD HH:MM:SS") into a short local time/date for display.
// Deliberately labeled "available until" everywhere in the UI — this is the donor's stated pickup
// deadline, not a certified food-safety expiry date.
function formatAvailableUntil(v) {
  if (!v) return '';
  // Stored as-entered from a datetime-local input (no timezone conversion either direction — see
  // normalizeAvailableUntil() in server.js) so it's parsed back as local time here too, to display
  // exactly what the donor typed rather than reinterpreting it against a timezone.
  const d = new Date(v.replace(' ', 'T'));
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function cardHtml(item) {
  const liked = state.wishlist.has(item.id);
  return `<div class="card" data-id="${item.id}">
    <div class="thumb">
      ${thumbInnerHtml(item)}
      <span class="price-badge">${itemPriceLabel(item)}</span>
      ${item.is_urgent ? `<span class="urgent-food-badge">🔥 Urgent</span>` : ''}
      <button type="button" class="wishlist-btn${liked ? ' active' : ''}" data-wish="${item.id}" aria-label="Save to wishlist">${HEART_SVG}</button>
    </div>
    <div class="body">
      <h3>${escapeHtml(item.title)}</h3>
      <div class="meta">${ownerNameHtml(item.owner_name, item.owner_verified, item.user_id)} • ${escapeHtml(displayCategory(item.category))} • ${timeAgo(item.created_at)}</div>
      ${item.available_until ? `<div class="food-until-hint">🕐 Available until ${escapeHtml(formatAvailableUntil(item.available_until))}</div>` : ''}
      <div class="footer-bar">
        <span class="loc">${LOC_SVG}${escapeHtml(item.owner_location || 'Nearby')}</span>
        ${pickupFlagHtml(item)}
        <span class="go-btn">View →</span>
      </div>
    </div>
  </div>`;
}

function bindWishlistButtons(container) {
  container.querySelectorAll('.wishlist-btn').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const id = Number(btn.dataset.wish);
      if (state.wishlist.has(id)) state.wishlist.delete(id); else state.wishlist.add(id);
      btn.classList.toggle('active');
    };
  });
}

function escapeHtml(s) { return (s || '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

// ---------- auth helpers (shared by login/signup/forgot/reset) ----------

// A network failure (offline, DNS, server unreachable) throws a TypeError from fetch itself,
// before api() ever gets a response to read `.error` from — worth a distinct message from "the
// server rejected your request" so users aren't told to check their password when it's actually
// their wifi.
function authErrorMessage(err) {
  if (err instanceof TypeError) return "Can't reach the server. Check your connection and try again.";
  return err.message || 'Something went wrong. Please try again.';
}

// Wires a 👁 show/hide toggle onto a password <input>. Icon and aria-label swap with state.
function wirePasswordToggle(toggleBtn) {
  const input = document.getElementById(toggleBtn.dataset.target);
  toggleBtn.onclick = () => {
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    toggleBtn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
    toggleBtn.innerHTML = `<i data-lucide="${showing ? 'eye' : 'eye-off'}"></i>`;
    if (window.lucide) lucide.createIcons();
    input.focus();
  };
}

function pwToggleHtml(targetId) {
  return `<button type="button" class="pw-toggle" data-target="${targetId}" aria-label="Show password"><i data-lucide="eye"></i></button>`;
}

// Simple, non-punishing strength heuristic — length plus a bit of character variety, not a
// checklist of mandatory symbol/number/uppercase rules that just makes people forget passwords.
function passwordStrength(pw) {
  if (!pw) return { score: 0, label: '' };
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw) || /[^A-Za-z0-9]/.test(pw)) score++;
  const levels = [
    { label: 'Weak', cls: 'weak' },
    { label: 'Weak', cls: 'weak' },
    { label: 'Fair', cls: 'fair' },
    { label: 'Good', cls: 'good' },
    { label: 'Strong', cls: 'strong' }
  ];
  return { score, ...levels[Math.min(score, 4)] };
}

function strengthMeterHtml(id) {
  return `<div class="strength-meter" id="${id}Bars" aria-hidden="true">
      <div class="strength-bar"></div><div class="strength-bar"></div><div class="strength-bar"></div><div class="strength-bar"></div>
    </div>
    <div class="strength-label" id="${id}Label" aria-live="polite"></div>`;
}

function wireStrengthMeter(inputEl, id) {
  const bars = document.querySelectorAll(`#${id}Bars .strength-bar`);
  const label = document.getElementById(`${id}Label`);
  inputEl.addEventListener('input', () => {
    const { score, label: text, cls } = passwordStrength(inputEl.value);
    bars.forEach((bar, i) => { bar.className = 'strength-bar' + (i < score ? ` on-${cls}` : ''); });
    label.textContent = inputEl.value ? `Password strength: ${text}` : '';
    label.className = 'strength-label' + (cls ? ` ${cls}` : '');
  });
}

// Every auth submit button goes through this: disable + loading label immediately, re-enable only
// on failure (success navigates/closes the modal, so there's nothing left to re-enable).
async function submitAuthForm(btn, busyText, action) {
  if (btn.disabled) return; // guards against double-click/double-submit
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyText;
  try {
    await action();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = original;
    throw err;
  }
}

// ---------- login / signup modal ----------
function openAuthModal(mode) {
  const isLogin = mode === 'login';
  showModal(`
    <h2>${isLogin ? 'Log in' : 'Create your account'}</h2>
    <form id="authForm" novalidate>
      ${!isLogin ? `<label for="authName">Full name</label><input id="authName" name="name" required minlength="2" maxlength="80" autocomplete="name">` : ''}
      <label for="authEmail">Email</label>
      <input id="authEmail" name="email" type="email" required maxlength="200" autocomplete="email">

      <label for="authPassword">Password</label>
      <div class="pw-field">
        <input id="authPassword" name="password" type="password" required minlength="6" maxlength="72"
          autocomplete="${isLogin ? 'current-password' : 'new-password'}">
        ${pwToggleHtml('authPassword')}
      </div>
      ${!isLogin ? strengthMeterHtml('authPassword') : ''}

      ${!isLogin ? `
      <label for="authConfirm">Confirm password</label>
      <div class="pw-field">
        <input id="authConfirm" name="confirmPassword" type="password" required minlength="6" maxlength="72" autocomplete="new-password">
        ${pwToggleHtml('authConfirm')}
      </div>
      <label for="authAccountType">Account type</label>
      <select id="authAccountType" name="account_type">
        <option value="individual">Individual</option>
        <option value="business">Business / Restaurant / Factory</option>
      </select>
      <label for="authLocation">Location (city/area)</label>
      <input id="authLocation" name="location" placeholder="e.g. Hyderabad" autocomplete="address-level2">
      <div class="checkbox-row">
        <input type="checkbox" id="authTerms" required>
        <label for="authTerms">I agree to the <a href="/terms.html" target="_blank" rel="noopener" style="color:var(--brand);font-weight:600">Terms &amp; Privacy Policy</a></label>
      </div>` : ''}

      <div class="error" id="authError" role="alert" aria-live="polite"></div>
      <button class="primary-btn" type="submit" id="authSubmit">${isLogin ? 'Log in' : 'Sign up'}</button>
    </form>
    <div class="auth-links">
      <span>${isLogin ? "Don't have an account?" : 'Already have an account?'}
        <a id="switchAuth">${isLogin ? 'Sign up' : 'Log in'}</a></span>
      ${isLogin ? `<a id="forgotPwLink">Forgot password?</a>` : ''}
    </div>
  `);

  document.querySelectorAll('.pw-toggle').forEach(wirePasswordToggle);
  if (!isLogin) wireStrengthMeter($('#authPassword'), 'authPassword');
  if (window.lucide) lucide.createIcons();

  $('#switchAuth').onclick = (e) => { e.preventDefault(); openAuthModal(isLogin ? 'signup' : 'login'); };
  if (isLogin) $('#forgotPwLink').onclick = (e) => { e.preventDefault(); openForgotPasswordModal(); };

  $('#authForm').onsubmit = async (e) => {
    e.preventDefault();
    const errEl = $('#authError');
    errEl.textContent = '';
    const fd = Object.fromEntries(new FormData(e.target));

    if (!isLogin) {
      if (fd.password !== fd.confirmPassword) { errEl.textContent = 'Passwords do not match.'; return; }
      if (fd.password.length < 6) { errEl.textContent = 'Password must be at least 6 characters.'; return; }
      if (!$('#authTerms').checked) { errEl.textContent = 'Please accept the Terms & Privacy Policy to continue.'; return; }
    }

    const btn = $('#authSubmit');
    try {
      await submitAuthForm(btn, isLogin ? 'Logging in…' : 'Creating account…', async () => {
        const { confirmPassword, ...body } = fd;
        const user = await api(isLogin ? '/api/login' : '/api/signup', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        state.user = user;
        closeModal();
        renderNav();
        loadItems();
      });
    } catch (err) { errEl.textContent = authErrorMessage(err); }
  };
}

// ---------- forgot password modal ----------
function openForgotPasswordModal() {
  showModal(`
    <button type="button" class="back-link" id="backToLogin"><i data-lucide="arrow-left"></i> Back to log in</button>
    <h2>Reset your password</h2>
    <p class="hint">Enter the email on your account and we'll send you a link to reset your password.</p>
    <form id="forgotForm" novalidate>
      <label for="forgotEmail">Email</label>
      <input id="forgotEmail" name="email" type="email" required maxlength="200" autocomplete="email">
      <div class="error" id="forgotError" role="alert" aria-live="polite"></div>
      <div class="success-text" id="forgotSuccess" role="status" aria-live="polite" style="display:none"></div>
      <button class="primary-btn" type="submit" id="forgotSubmit">Send reset link</button>
    </form>
  `);
  if (window.lucide) lucide.createIcons();
  $('#backToLogin').onclick = () => openAuthModal('login');
  $('#forgotForm').onsubmit = async (e) => {
    e.preventDefault();
    const errEl = $('#forgotError'), okEl = $('#forgotSuccess');
    errEl.textContent = ''; okEl.style.display = 'none';
    const email = $('#forgotEmail').value.trim();
    const btn = $('#forgotSubmit');
    try {
      await submitAuthForm(btn, 'Sending…', async () => {
        const resp = await api('/api/forgot-password', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email })
        });
        // Same message no matter what — the backend never tells us whether the account exists,
        // and the frontend shouldn't try to guess or display anything more specific either.
        okEl.textContent = resp.message || 'If an account exists for that email, password reset instructions will be sent.';
        okEl.style.display = 'block';
        $('#forgotForm').querySelector('input').setAttribute('disabled', 'true');
        btn.textContent = 'Sent';
        // Dev-only convenience: no email provider is wired up yet, so surface the raw reset link
        // right in the UI when the server hands one back (it only ever does this outside
        // production — see server.js). Never happens against a real deployment.
        if (resp.dev_reset_token) {
          const link = `${location.origin}${location.pathname}?reset=${encodeURIComponent(resp.dev_reset_token)}`;
          okEl.innerHTML += `<br><span style="font-weight:400;color:var(--muted)">Dev mode — no email provider connected yet:</span><br><a href="${link}" style="word-break:break-all">${link}</a>`;
        }
      });
    } catch (err) { errEl.textContent = authErrorMessage(err); }
  };
}

// ---------- reset password modal (arrived at via ?reset=TOKEN link) ----------
function openResetPasswordModal(token) {
  showModal(`
    <h2>Choose a new password</h2>
    <form id="resetForm" novalidate>
      <label for="resetPassword">New password</label>
      <div class="pw-field">
        <input id="resetPassword" name="newPassword" type="password" required minlength="6" maxlength="72" autocomplete="new-password">
        ${pwToggleHtml('resetPassword')}
      </div>
      ${strengthMeterHtml('resetPassword')}
      <label for="resetConfirm">Confirm new password</label>
      <div class="pw-field">
        <input id="resetConfirm" name="confirmPassword" type="password" required minlength="6" maxlength="72" autocomplete="new-password">
        ${pwToggleHtml('resetConfirm')}
      </div>
      <div class="error" id="resetError" role="alert" aria-live="polite"></div>
      <button class="primary-btn" type="submit" id="resetSubmit">Reset password</button>
    </form>
  `);
  document.querySelectorAll('.pw-toggle').forEach(wirePasswordToggle);
  wireStrengthMeter($('#resetPassword'), 'resetPassword');
  if (window.lucide) lucide.createIcons();

  $('#resetForm').onsubmit = async (e) => {
    e.preventDefault();
    const errEl = $('#resetError');
    errEl.textContent = '';
    const newPassword = $('#resetPassword').value;
    const confirmPassword = $('#resetConfirm').value;
    if (newPassword !== confirmPassword) { errEl.textContent = 'Passwords do not match.'; return; }
    if (newPassword.length < 6) { errEl.textContent = 'Password must be at least 6 characters.'; return; }

    const btn = $('#resetSubmit');
    try {
      await submitAuthForm(btn, 'Resetting…', async () => {
        await api('/api/reset-password', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, newPassword, confirmPassword })
        });
        showResetSuccessModal();
      });
    } catch (err) {
      // An invalid/expired/already-used token is a distinct dead-end state — offer a way to
      // request a fresh link rather than just leaving an error message on a form that can only
      // ever fail again with the same token.
      if (/invalid or expired/i.test(err.message || '')) {
        showResetTokenInvalidModal();
      } else {
        errEl.textContent = authErrorMessage(err);
      }
    }
  };
}

function showResetSuccessModal() {
  showModal(`
    <h2>Password changed</h2>
    <p class="hint">Your password has been updated, and you've been logged out everywhere for your security. Log in with your new password to continue.</p>
    <button class="primary-btn" id="resetDoneLogin">Log in</button>
  `);
  $('#resetDoneLogin').onclick = () => openAuthModal('login');
}

function showResetTokenInvalidModal() {
  showModal(`
    <h2>Link expired</h2>
    <p class="hint">This password reset link is invalid or has already been used. Reset links expire after 30 minutes — request a new one below.</p>
    <button class="primary-btn" id="resetTryAgain">Request a new link</button>
  `);
  $('#resetTryAgain').onclick = () => openForgotPasswordModal();
}

// If the page was opened from a password-reset email link (?reset=TOKEN), jump straight into the
// reset flow and then scrub the token out of the visible URL/history so it doesn't linger there
// longer than necessary.
function checkResetTokenInUrl() {
  const params = new URLSearchParams(location.search);
  const token = params.get('reset');
  if (!token) return;
  openResetPasswordModal(token);
  params.delete('reset');
  const clean = location.pathname + (params.toString() ? `?${params}` : '') + location.hash;
  history.replaceState(null, '', clean);
}

// ---------- post item modal ----------
// Mirrors server.js FOOD_CATEGORIES — which categories trigger the Food Rescue fields at all.
const FOOD_CATEGORIES_FRONT = ['Food (Surplus)', 'Food & Organic Waste'];
// Mirrors server.js BUSINESS_SURPLUS_CATEGORIES — the five reusable-goods categories that get the
// optional (not required, unlike food) available-until/urgent fields.
const BUSINESS_SURPLUS_CATEGORIES_FRONT = ['Office Furniture & Fixtures', 'Business Equipment & Machinery', 'Electronics & IT Equipment', 'Packaging Material', 'Retail / Event Surplus'];
const FOOD_PREF_OPTIONS = [
  { value: 'not_specified', label: 'Not specified' },
  { value: 'vegetarian', label: 'Vegetarian' },
  { value: 'non_vegetarian', label: 'Non-vegetarian' },
  { value: 'mixed', label: 'Mixed' }
];

function openPostModal() {
  const isBusiness = state.section === 'business_waste';
  showModal(`
    <h2>${isBusiness ? 'Post business surplus' : 'Post an item'}</h2>
    <p class="modal-subtitle">Share items you no longer need. Help someone. Help the planet. 🌱</p>
    <form id="postForm" class="post-item-form">

      <div class="form-section">
        <div class="form-section-head"><span class="form-section-num">1</span>Basic Details</div>

        <label>Title <span class="req">*</span></label>
        <input name="title" required maxlength="120" id="postTitle" placeholder="${isBusiness ? 'e.g. 20 office chairs, CNC metal scrap' : 'e.g. Old iPhone 8, working condition'}">

        <label>Photos <span class="hint-inline">Optional · Up to 5 photos</span></label>
        <div class="photo-dropzone" id="photoDropzone" tabindex="0" role="button" aria-label="Upload photos">
          <span class="photo-dropzone-icon">📷</span>
          <span class="photo-dropzone-text"><strong>Upload photos</strong><br>or drag and drop</span>
          <input type="file" name="media" id="mediaInput" accept="image/*,video/*" multiple class="photo-input-hidden">
        </div>
        <div class="photo-thumbs" id="photoThumbs"></div>
        <p class="hint">Good photos = more chances to find the right person.</p>

        <label>Description <span class="req">*</span></label>
        <textarea name="description" required maxlength="1500" placeholder="Describe condition, pickup details, reason for giving, etc."></textarea>
      </div>

      <div class="form-section">
        <div class="form-section-head"><span class="form-section-num">2</span>Item Details</div>

        <label>Category <span class="req">*</span></label>
        <select name="category" id="postCategory" required>${activeCategoryList().map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')}</select>

        <div class="row2">
          <div><label>Condition <span class="req">*</span></label>
            <select name="condition"><option value="new">New</option><option value="like_new">Like new</option><option value="used" selected>Used</option><option value="needs_repair">Needs repair</option></select>
          </div>
          <div><label>Quantity</label><input name="quantity" placeholder="e.g. 50 kg, 200 L, 2 pieces"></div>
        </div>

        <label>Offer type <span class="req">*</span></label>
        <select name="price_type" id="priceType" class="visually-hidden-select">
          <option value="free">Free — give it away</option>
          <option value="paid">Paid — sell for a price</option>
          <option value="exchange">Exchange — swap for something</option>
          <option value="rent">Rent — let others borrow it for a rate</option>
        </select>
        <div class="offer-type-cards" id="offerTypeCards">
          <button type="button" class="offer-type-card" data-value="free"><span class="offer-type-icon">🎁</span><strong>Free</strong><small>Give it away</small></button>
          <button type="button" class="offer-type-card" data-value="exchange"><span class="offer-type-icon">⇄</span><strong>Swap / Exchange</strong><small>Trade with others</small></button>
          <button type="button" class="offer-type-card" data-value="paid"><span class="offer-type-icon">🏷</span><strong>Paid / For Sale</strong><small>Selling this item</small></button>
          <button type="button" class="offer-type-card" data-value="rent"><span class="offer-type-icon">🕐</span><strong>Rent</strong><small>Let others borrow it</small></button>
        </div>
        <div id="priceExtra"></div>
      </div>

      <div class="form-section">
        <div class="form-section-head"><span class="form-section-num">3</span>Pickup &amp; Location</div>

        <label class="checkbox-row-inline"><input type="checkbox" name="pickup_available" id="pickupAvailable" checked>Pickup is available for this listing</label>
        <p class="hint" style="margin-top:-4px">Buyers can pick up the item from you.</p>

        ${pickupFieldsHtml()}
        <p class="hint">Your exact address will not be shared publicly.</p>
      </div>

      <div class="form-section form-section-special" id="specialOptionsSection">
        <div class="form-section-head"><span class="form-section-num">4</span>Special Options <span class="hint-inline">(shown when relevant)</span></div>

        <label class="checkbox-row-inline"><input type="checkbox" name="is_recurring" id="isRecurring">${isBusiness ? 'This is a recurring byproduct (e.g. weekly scrap, daily used oil)' : 'This is a recurring surplus (e.g. daily leftover food from my restaurant)'}</label>
        <div id="freqExtra"></div>

        <div id="foodExtra"></div>
        <div id="bizSurplusExtra"></div>
      </div>

      <div class="error" id="postError"></div>
      <div class="post-form-footer">
        <p class="hint post-privacy-note">🔒 Your exact pickup address is never shown publicly.</p>
        <div class="post-form-actions">
          <button type="button" class="ghost" id="postCancelBtn">Cancel</button>
          <button class="primary-btn" type="submit">✓ Post Item</button>
        </div>
      </div>
    </form>
  `);
  const postModalEl = document.querySelector('.modal-overlay .modal');
  if (postModalEl) postModalEl.classList.add('post-item-modal');
  $('#postCancelBtn').onclick = () => closeModal();

  // ---------- offer-type card UI (drives the existing #priceType select; no new backend field) ----------
  const priceTypeSelect = $('#priceType');
  const offerCards = Array.from(document.querySelectorAll('#offerTypeCards .offer-type-card'));
  function syncOfferCards() {
    offerCards.forEach(btn => btn.classList.toggle('active', btn.dataset.value === priceTypeSelect.value));
  }
  offerCards.forEach(btn => {
    btn.onclick = () => {
      priceTypeSelect.value = btn.dataset.value;
      priceTypeSelect.dispatchEvent(new Event('change'));
      syncOfferCards();
    };
  });
  syncOfferCards();

  // ---------- photo dropzone (reuses the existing #mediaInput file input — same name, same
  // validation, same 5-file/8MB server-side limits; this only adds a preview, no new upload path) ----------
  const mediaInput = $('#mediaInput');
  const dropzone = $('#photoDropzone');
  const photoThumbs = $('#photoThumbs');
  function renderPhotoThumbs() {
    const files = Array.from(mediaInput.files || []);
    photoThumbs.innerHTML = '';
    files.forEach((file, i) => {
      const thumb = document.createElement('div');
      thumb.className = 'photo-thumb';
      if (file.type.startsWith('image/')) {
        const url = URL.createObjectURL(file);
        thumb.innerHTML = `<img src="${url}" alt="">`;
      } else {
        thumb.innerHTML = `<span class="photo-thumb-file">🎞️</span>`;
      }
      thumb.title = file.name;
      photoThumbs.appendChild(thumb);
    });
  }
  dropzone.onclick = () => mediaInput.click();
  dropzone.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); mediaInput.click(); } };
  mediaInput.onchange = renderPhotoThumbs;
  ['dragover', 'dragenter'].forEach(evt => dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add('dragover'); }));
  ['dragleave', 'dragend', 'drop'].forEach(evt => dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove('dragover'); }));
  dropzone.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      mediaInput.files = e.dataTransfer.files; // same input, same field — just populated via drop
      renderPhotoThumbs();
    }
  });
  const priceExtra = $('#priceExtra');
  const updatePriceExtra = () => {
    const v = $('#priceType').value;
    if (v === 'paid') priceExtra.innerHTML = `<label>Price (₹)</label><input name="price" type="number" min="0" step="1" required>`;
    else if (v === 'exchange') priceExtra.innerHTML = `<label>What would you like in exchange?</label><input name="exchange_for" placeholder="e.g. gardening tools, cooking gas cylinder">`;
    else if (v === 'rent') priceExtra.innerHTML = `
      <div class="row2">
        <div><label>Rent rate (₹)</label><input name="rent_rate" type="number" min="0" step="1" required></div>
        <div><label>Per</label><select name="rent_period"><option value="day">Day</option><option value="week">Week</option><option value="month">Month</option></select></div>
      </div>
      <label>Suggested security deposit (₹, optional)</label><input name="deposit" type="number" min="0" step="1" placeholder="e.g. 500">
      <p class="hint">Renter and owner arrange payment and deposit between themselves — the site just makes the connection.</p>`;
    else priceExtra.innerHTML = '';
  };
  updatePriceExtra();
  $('#priceType').onchange = updatePriceExtra;

  const freqExtra = $('#freqExtra');
  $('#isRecurring').onchange = () => {
    freqExtra.innerHTML = $('#isRecurring').checked
      ? `<label>How often?</label><select name="frequency"><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select>`
      : '';
  };

  bindPickupFields();

  // ---------- Food Rescue fields (only shown for food categories) ----------
  const foodExtra = $('#foodExtra');
  function renderFoodFields() {
    const category = $('#postCategory').value;
    const showEdibleToggle = category === 'Food & Organic Waste';
    // 'Food (Surplus)' is always edible; for 'Food & Organic Waste' (which mixes real surplus
    // food with genuine inedible waste like compost material) the donor says which this is.
    const edible = category === 'Food (Surplus)' || (showEdibleToggle && $('#isEdibleFood') && $('#isEdibleFood').checked);
    const fieldsBlock = $('#foodFieldsBlock');
    if (fieldsBlock) {
      fieldsBlock.innerHTML = edible ? `
        <label>Food available until <span class="hint">(your pickup deadline — not a certified food-safety expiry date)</span></label>
        <input type="datetime-local" name="available_until" required>
        <label>Food type</label>
        <select name="food_pref">${FOOD_PREF_OPTIONS.map(o => `<option value="${o.value}">${o.label}</option>`).join('')}</select>
        <label><input type="checkbox" id="foodUrgent" style="width:auto;display:inline-block;margin-right:6px">🔥 Urgent — pickup needed soon</label>
        <p class="hint food-safety-hint">Food safety: Please share accurate information about the food and its condition. ReUse Hub does not inspect or certify food safety. Recipients should use their own judgment before consuming.</p>
      ` : '';
    }
  }
  function renderFoodExtra() {
    const category = $('#postCategory').value;
    if (!FOOD_CATEGORIES_FRONT.includes(category)) { foodExtra.innerHTML = ''; return; }
    const showEdibleToggle = category === 'Food & Organic Waste';
    foodExtra.innerHTML = `
      ${showEdibleToggle ? `<label><input type="checkbox" id="isEdibleFood" style="width:auto;display:inline-block;margin-right:6px">This is edible surplus food (not waste for composting/feed)</label>` : ''}
      <div id="foodFieldsBlock"></div>
    `;
    if (showEdibleToggle) $('#isEdibleFood').onchange = renderFoodFields;
    renderFoodFields();
  }
  // ---------- Business Surplus fields (optional — only shown for the 5 reusable-goods
  // categories, unlike Food Rescue's required deadline; no edible/inedible split needed here). ----------
  const bizSurplusExtra = $('#bizSurplusExtra');
  function renderBizSurplusExtra() {
    const category = $('#postCategory').value;
    if (!BUSINESS_SURPLUS_CATEGORIES_FRONT.includes(category)) { bizSurplusExtra.innerHTML = ''; return; }
    bizSurplusExtra.innerHTML = `
      <label>Business Surplus details</label>
      <label class="hint" style="margin-top:0">Available until <span class="hint">(optional — a pickup deadline, not a certified expiry date)</span></label>
      <input type="datetime-local" name="available_until">
      <label><input type="checkbox" id="bizUrgent" style="width:auto;display:inline-block;margin-right:6px">🔥 Urgent — pickup needed soon</label>
    `;
  }
  function renderCategoryExtras() { renderFoodExtra(); renderBizSurplusExtra(); }
  renderCategoryExtras();
  $('#postCategory').onchange = renderCategoryExtras;

  $('#postForm').onsubmit = async (e) => {
    e.preventDefault();
    const submitBtn = e.target.querySelector('button[type="submit"]');
    if (submitBtn.disabled) return; // guard against double-tap/double-click firing two submits
    submitBtn.disabled = true;
    const fd = new FormData(e.target);
    fd.set('is_recurring', $('#isRecurring').checked ? 'true' : 'false');
    fd.set('pickup_available', $('#pickupAvailable').checked ? 'true' : 'false');
    fd.set('listing_type', state.section);
    // Only one of these ever exists in the DOM at once (category is mutually exclusive between
    // food and business-surplus groups), so checking both and OR-ing is safe either way.
    const foodUrgentEl = document.getElementById('foodUrgent');
    const bizUrgentEl = document.getElementById('bizUrgent');
    fd.set('is_urgent', (foodUrgentEl && foodUrgentEl.checked) || (bizUrgentEl && bizUrgentEl.checked) ? 'true' : 'false');
    const edibleEl = document.getElementById('isEdibleFood');
    fd.set('is_edible_food', edibleEl && edibleEl.checked ? 'true' : 'false');
    try {
      const posted = await api('/api/items', { method: 'POST', body: fd });
      closeModal();
      loadItems();
      loadTrending();
      // Image Moderation V1: a photo can land in review instead of publishing instantly — let the
      // poster know rather than leaving them wondering why a photo they uploaded isn't showing yet.
      if (posted && posted.pending_media_count > 0) {
        alert(`Your listing is live! ${posted.pending_media_count} photo${posted.pending_media_count > 1 ? 's are' : ' is'} still being reviewed and will appear once approved (usually quick).`);
      }
    } catch (err) {
      $('#postError').textContent = err.message;
      submitBtn.disabled = false; // allow retry after a real error
    }
  };
}

// ---------- pickup location (safe: public only ever sees pickup_area, never the exact address) ----------
function pickupFieldsHtml(item) {
  const t = (item && item.pickup_type) || 'public_point';
  return `
    <label>Pickup option</label>
    <select name="pickup_type" id="pickupType">
      <option value="public_point" ${t === 'public_point' ? 'selected' : ''}>Public pickup point (recommended)</option>
      <option value="my_address" ${t === 'my_address' ? 'selected' : ''}>My address</option>
      <option value="business_location" ${t === 'business_location' ? 'selected' : ''}>Business location</option>
      <option value="custom" ${t === 'custom' ? 'selected' : ''}>Custom pickup point / instructions</option>
    </select>
    <label>Approximate area shown to everyone <span class="hint">(e.g. "Arakkonam ~2 km away" or "Near Railway Station" — never your exact address)</span></label>
    <input name="pickup_area" id="pickupArea" placeholder="e.g. Near Arakkonam Railway Station" value="${escapeHtml((item && item.pickup_area) || '')}">
    <label>Exact pickup address <span class="hint">(only shown to you and the person you accept)</span></label>
    <input name="pickup_address" id="pickupAddress" placeholder="e.g. 12 Gandhi Street, Arakkonam" value="${escapeHtml((item && item.pickup_address) || '')}">
    <label>Pickup instructions (optional)</label>
    <textarea name="pickup_instructions" id="pickupInstructions" placeholder="e.g. Collect from the main entrance after 6pm">${escapeHtml((item && item.pickup_instructions) || '')}</textarea>
  `;
}
function bindPickupFields() {} // placeholder hook if per-type UI is added later

function mapsUrl(address) { return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`; }

function exactPickupHtml(item) {
  if (!item.pickup_address) return '';
  return `<div class="pickup-exact">
    <div class="pickup-exact-title">📍 Pickup details</div>
    <div class="pickup-exact-address">${escapeHtml(item.pickup_address)}</div>
    ${item.pickup_instructions ? `<div class="pickup-exact-instructions">${escapeHtml(item.pickup_instructions)}</div>` : ''}
    <div class="pickup-exact-actions">
      <a class="maps-btn" href="${mapsUrl(item.pickup_address)}" target="_blank" rel="noopener">📍 Open in Google Maps</a>
      <button type="button" class="copy-btn" data-copy="${escapeHtml(item.pickup_address)}">Copy address</button>
    </div>
  </div>`;
}
function bindCopyButtons(root) {
  (root || document).querySelectorAll('.copy-btn').forEach(btn => {
    btn.onclick = () => {
      const text = btn.dataset.copy;
      if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    };
  });
}

// ---------- item detail ----------
async function openDetail(id) {
  const item = await api('/api/items/' + id);
  const isOwner = state.user && state.user.id === item.user_id;
  showModal(`
    ${galleryHtml(item)}
    <h2>${escapeHtml(item.title)}</h2>
    ${badgeHtml(item)}
    <p style="margin-top:12px">${escapeHtml(item.description)}</p>
    <div class="hint">Category: ${escapeHtml(displayCategory(item.category))} · Condition: ${escapeHtml(item.condition)} ${item.quantity ? '· Qty: ' + escapeHtml(item.quantity) : ''}</div>
    ${item.price_type === 'exchange' && item.exchange_for ? `<div class="hint">Wants in exchange: ${escapeHtml(item.exchange_for)}</div>` : ''}
    ${item.price_type === 'rent' ? `<div class="hint">Rent: ₹${item.rent_rate}/${escapeHtml(item.rent_period || 'day')}${item.deposit ? ` · Suggested deposit: ₹${item.deposit}` : ''}</div>` : ''}
    ${item.is_recurring ? `<div class="hint">Recurring ${escapeHtml(item.frequency)} surplus posting.</div>` : ''}
    ${item.available_until ? `<div class="hint food-until-hint">🕐 Food available until ${escapeHtml(formatAvailableUntil(item.available_until))} <span class="hint">(donor's stated pickup deadline, not a certified food-safety date)</span></div>` : ''}
    <div class="detail-owner">
      Posted by <button type="button" class="owner-name-link" data-uid="${escapeHtml(item.user_id)}"><strong>${escapeHtml(item.owner_name)}</strong></button> ${item.owner_type === 'business' ? '<span class="owner-badge">Business</span>' : '<span class="owner-badge">Individual</span>'}
      ${item.owner_verified ? ' <span class="verified-badge">✓ Verified</span>' : ''}
      ${item.owner_location ? `<br>Location: ${escapeHtml(item.owner_location)}` : ''}
    </div>
    ${item.pickup_area ? `<div class="hint">📍 ${escapeHtml(item.pickup_area)}</div>` : ''}
    ${exactPickupHtml(item)}
    ${isOwner ? `
      <button class="primary-btn" id="editItemBtn">Edit</button>
      <button class="primary-btn" id="closeItemBtn" style="background:#c0392b">Mark as given away / closed</button>
    ` : `
      <form id="claimForm">
        <label>Message to owner (optional)</label>
        <textarea name="message" placeholder="e.g. I'd like to pick this up tomorrow"></textarea>
        <div class="error" id="claimError"></div>
        <button class="primary-btn" type="submit">${item.price_type === 'paid' ? 'Request to buy' : item.price_type === 'exchange' ? 'Propose exchange' : item.price_type === 'rent' ? 'Request to rent' : 'Request this item'}</button>
      </form>
      ${state.user ? `<p style="margin-top:10px"><a href="#" id="reportLink" style="color:#c0392b;font-size:12px">Report this post</a></p>` : ''}
    `}
  `);
  if (isOwner) {
    $('#editItemBtn').onclick = () => openEditModal(item);
    $('#closeItemBtn').onclick = async () => {
      await api('/api/items/' + item.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'closed' }) });
      closeModal(); loadItems();
    };
  } else {
    $('#claimForm').onsubmit = async (e) => {
      e.preventDefault();
      if (!state.user) { closeModal(); openAuthModal('login'); return; }
      const fd = Object.fromEntries(new FormData(e.target));
      try {
        await api(`/api/items/${item.id}/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fd) });
        closeModal();
        alert('Request sent to the owner!');
        loadTrending();
      } catch (err) { $('#claimError').textContent = err.message; }
    };
    const reportLink = $('#reportLink');
    if (reportLink) reportLink.onclick = (e) => { e.preventDefault(); openReportModal('item', item.id); };
  }
  // Wire the gallery strip up to the lightbox — real uploaded photos only (videos in .gallery
  // render as <video>, not <img>, so they're naturally excluded here).
  const media = (item.media && item.media.length) ? item.media : (item.media_url ? [{ url: item.media_url, media_type: item.media_type }] : []);
  const galleryImages = media.filter(m => m.media_type !== 'video');
  modalRoot.querySelectorAll('.gallery img').forEach((img, i) => { img.onclick = () => openLightbox(galleryImages, i); img.style.cursor = 'zoom-in'; });
  bindCopyButtons();
}

// ---------- edit item modal ----------
function openEditModal(item) {
  showModal(`
    <h2>Edit item</h2>
    <form id="editForm">
      <label>Title</label><input name="title" required value="${escapeHtml(item.title)}">
      <label>Description</label><textarea name="description" required>${escapeHtml(item.description)}</textarea>
      <label>Category</label>
      <select name="category" required>${(item.listing_type === 'business_waste' ? state.businessCategories : state.categories).map(c => `<option value="${escapeHtml(c)}" ${c === displayCategory(item.category) ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}</select>
      <div class="row2">
        <div><label>Condition</label>
          <select name="condition">
            <option value="new" ${item.condition === 'new' ? 'selected' : ''}>New</option>
            <option value="like_new" ${item.condition === 'like_new' ? 'selected' : ''}>Like new</option>
            <option value="used" ${item.condition === 'used' ? 'selected' : ''}>Used</option>
            <option value="needs_repair" ${item.condition === 'needs_repair' ? 'selected' : ''}>Needs repair</option>
          </select>
        </div>
        <div><label>Quantity</label><input name="quantity" value="${escapeHtml(item.quantity || '')}"></div>
      </div>
      <label>Offer type</label>
      <select name="price_type" id="editPriceType">
        <option value="free" ${item.price_type === 'free' ? 'selected' : ''}>Free — give it away</option>
        <option value="paid" ${item.price_type === 'paid' ? 'selected' : ''}>Paid — sell for a price</option>
        <option value="exchange" ${item.price_type === 'exchange' ? 'selected' : ''}>Exchange — swap for something</option>
        <option value="rent" ${item.price_type === 'rent' ? 'selected' : ''}>Rent — let others borrow it for a rate</option>
      </select>
      <div id="editPriceExtra"></div>
      ${pickupFieldsHtml(item)}
      <p class="hint">Note: editing does not change already-uploaded photos.</p>
      <div class="error" id="editError"></div>
      <button class="primary-btn" type="submit">Save changes</button>
    </form>
  `);
  const editPriceExtra = $('#editPriceExtra');
  const updateEditPriceExtra = () => {
    const v = $('#editPriceType').value;
    if (v === 'paid') editPriceExtra.innerHTML = `<label>Price (₹)</label><input name="price" type="number" min="0" step="1" value="${item.price || 0}" required>`;
    else if (v === 'exchange') editPriceExtra.innerHTML = `<label>What would you like in exchange?</label><input name="exchange_for" value="${escapeHtml(item.exchange_for || '')}">`;
    else if (v === 'rent') editPriceExtra.innerHTML = `
      <div class="row2">
        <div><label>Rent rate (₹)</label><input name="rent_rate" type="number" min="0" step="1" value="${item.rent_rate || 0}" required></div>
        <div><label>Per</label><select name="rent_period">
          <option value="day" ${item.rent_period === 'day' ? 'selected' : ''}>Day</option>
          <option value="week" ${item.rent_period === 'week' ? 'selected' : ''}>Week</option>
          <option value="month" ${item.rent_period === 'month' ? 'selected' : ''}>Month</option>
        </select></div>
      </div>
      <label>Suggested security deposit (₹, optional)</label><input name="deposit" type="number" min="0" step="1" value="${item.deposit || 0}">`;
    else editPriceExtra.innerHTML = '';
  };
  updateEditPriceExtra();
  $('#editPriceType').onchange = updateEditPriceExtra;

  $('#editForm').onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    try {
      await api('/api/items/' + item.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fd) });
      closeModal();
      loadItems();
      openDetail(item.id);
    } catch (err) { $('#editError').textContent = err.message; }
  };
}

// ---------- post request modal (reverse marketplace) ----------
function openPostRequestModal() {
  const isService = state.requestType === 'service';
  showModal(`
    <h2>Post what you need</h2>
    <form id="postRequestForm">
      <input type="hidden" name="request_type" value="${state.requestType}">
      <label>Title</label><input name="title" required placeholder="${isService ? 'e.g. Need an electrician for a fan installation' : 'e.g. Need a study table for a week'}">
      <label>Description</label><textarea name="description" required placeholder="Describe exactly what you need, timing, location, etc."></textarea>
      <label>Category</label>
      <select name="category" required>${(isService ? state.serviceCategories : state.categories).map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')}</select>
      <label>Quantity (optional)</label><input name="quantity" placeholder="e.g. 2 units, 1 visit">
      <label>Budget</label>
      <select name="budget_type" id="budgetType">
        <option value="free">No budget — hoping for free help</option>
        <option value="paid">I'll pay</option>
        <option value="exchange">I'll exchange for something</option>
      </select>
      <div id="budgetExtra"></div>
      <label><input type="checkbox" name="is_urgent" id="isUrgent" style="width:auto;display:inline-block;margin-right:6px">This is urgent</label>
      <div class="error" id="postRequestError"></div>
      <button class="primary-btn" type="submit">Post request</button>
    </form>
  `);
  const budgetExtra = $('#budgetExtra');
  const updateBudgetExtra = () => {
    const v = $('#budgetType').value;
    if (v === 'paid') budgetExtra.innerHTML = `<label>How much are you willing to pay (₹)?</label><input name="budget_amount" type="number" min="0" step="1" required>`;
    else if (v === 'exchange') budgetExtra.innerHTML = `<label>What can you offer in exchange?</label><input name="exchange_for" placeholder="e.g. help with something else, an item you have">`;
    else budgetExtra.innerHTML = '';
  };
  updateBudgetExtra();
  $('#budgetType').onchange = updateBudgetExtra;

  $('#postRequestForm').onsubmit = async (e) => {
    e.preventDefault();
    const submitBtn = e.target.querySelector('button[type="submit"]');
    if (submitBtn.disabled) return; // guard against double-tap/double-click firing two submits
    submitBtn.disabled = true;
    const fd = Object.fromEntries(new FormData(e.target));
    fd.is_urgent = $('#isUrgent').checked ? 'true' : 'false';
    try {
      await api('/api/requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fd) });
      closeModal();
      loadRequests();
    } catch (err) {
      $('#postRequestError').textContent = err.message;
      submitBtn.disabled = false;
    }
  };
}

// ---------- request detail ----------
async function openRequestDetail(id) {
  const r = await api('/api/requests/' + id);
  const isOwner = state.user && state.user.id === r.user_id;
  showModal(`
    <h2>${escapeHtml(r.title)}</h2>
    ${requestBadgeHtml(r)}
    <p style="margin-top:12px">${escapeHtml(r.description)}</p>
    <div class="hint">Category: ${escapeHtml(displayCategory(r.category))} ${r.quantity ? '· Qty: ' + escapeHtml(r.quantity) : ''}</div>
    ${r.budget_type === 'exchange' && r.exchange_for ? `<div class="hint">Can exchange for: ${escapeHtml(r.exchange_for)}</div>` : ''}
    <div class="detail-owner">
      Posted by <button type="button" class="owner-name-link" data-uid="${escapeHtml(r.user_id)}"><strong>${escapeHtml(r.owner_name)}</strong></button> ${r.owner_type === 'business' ? '<span class="owner-badge">Business</span>' : '<span class="owner-badge">Individual</span>'}
      ${r.owner_verified ? ' <span class="verified-badge">✓ Verified</span>' : ''}
      ${r.owner_location ? `<br>Location: ${escapeHtml(r.owner_location)}` : ''}
    </div>
    ${isOwner ? `
      <button class="primary-btn" id="closeRequestBtn" style="background:#c0392b">Mark as fulfilled / closed</button>
    ` : `
      <form id="respondForm">
        <label>How can you help? (optional)</label>
        <textarea name="message" placeholder="e.g. I have one available, can drop it off tomorrow"></textarea>
        ${r.budget_type === 'paid' ? `<label>Your price (₹, optional)</label><input name="offered_price" type="number" min="0" step="1" placeholder="Leave blank to accept their budget">` : ''}
        ${pickupFieldsHtml()}
        <div class="error" id="respondError"></div>
        <button class="primary-btn" type="submit">I can help</button>
      </form>
      ${state.user ? `<p style="margin-top:10px"><a href="#" id="reportRequestLink" style="color:#c0392b;font-size:12px">Report this post</a></p>` : ''}
    `}
  `);
  if (isOwner) {
    $('#closeRequestBtn').onclick = async () => {
      await api('/api/requests/' + r.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'closed' }) });
      closeModal(); loadRequests();
    };
  } else {
    $('#respondForm').onsubmit = async (e) => {
      e.preventDefault();
      if (!state.user) { closeModal(); openAuthModal('login'); return; }
      const fd = Object.fromEntries(new FormData(e.target));
      try {
        await api(`/api/requests/${r.id}/respond`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fd) });
        closeModal();
        alert('Your offer to help was sent!');
      } catch (err) { $('#respondError').textContent = err.message; }
    };
    const reportLink = $('#reportRequestLink');
    if (reportLink) reportLink.onclick = (e) => { e.preventDefault(); openReportModal('request', r.id); };
  }
}

// ---------- report modal ----------
const REPORT_LABELS = { user: 'this user', rating: 'this review', item: 'this post', request: 'this post' };
function openReportModal(targetType, targetId) {
  showModal(`
    <h2>Report ${REPORT_LABELS[targetType] || 'this post'}</h2>
    <form id="reportForm">
      <label>What's wrong?</label>
      <textarea name="reason" required placeholder="e.g. Fake listing, inappropriate content, scam attempt"></textarea>
      <div class="error" id="reportError"></div>
      <button class="primary-btn" type="submit">Submit report</button>
    </form>
  `);
  $('#reportForm').onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    try {
      await api('/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target_type: targetType, target_id: targetId, reason: fd.reason }) });
      closeModal();
      alert('Thanks — this has been reported.');
    } catch (err) { $('#reportError').textContent = err.message; }
  };
}

// ---------- admin dashboard (Trust & Safety V1) ----------
// Lean, single-admin-operable moderation view: an open-reports queue with inline resolve/dismiss
// and quick actions (close listing / ban reported user), plus a read-only moderation history tab.
// Gated purely by state.user.is_admin (which mirrors the server's own is_admin column) — the nav
// button that opens this is already hidden for non-admins, and every action here calls a
// requireAdmin-protected /api/admin/... route, so hiding the button is a convenience, not the
// actual security boundary.
const REPORT_STATUS_LABELS = { open: 'Open', resolved: 'Resolved', dismissed: 'Dismissed' };
async function openAdminDashboard(tab = 'reports', statusFilter = 'open') {
  showModal(`
    <h2>🛡️ Admin</h2>
    <div class="admin-tabs">
      <button class="chip ${tab === 'reports' ? 'active' : ''}" id="adminTabReports">Reports</button>
      <button class="chip ${tab === 'images' ? 'active' : ''}" id="adminTabImages">Flagged Images</button>
      <button class="chip ${tab === 'log' ? 'active' : ''}" id="adminTabLog">Moderation history</button>
    </div>
    <div id="adminTabContent">Loading...</div>
  `);
  $('#adminTabReports').onclick = () => openAdminDashboard('reports', statusFilter);
  $('#adminTabImages').onclick = () => openAdminDashboard('images');
  $('#adminTabLog').onclick = () => openAdminDashboard('log');

  if (tab === 'images') {
    try {
      const rows = await api('/api/admin/images/pending');
      $('#adminTabContent').innerHTML = rows.length ? `
        <div class="admin-reports">${rows.map(m => `
          <div class="admin-report-row" data-media-id="${m.id}">
            <img class="admin-flagged-thumb" src="/api/admin/images/${m.id}/file" alt="Pending review" loading="lazy">
            <div><strong>${escapeHtml(m.item_title)}</strong> <span class="hint">by ${escapeHtml(m.owner_name)}</span></div>
            <div class="hint">${escapeHtml(m.moderation_note || '')} · ${escapeHtml(m.created_at)}</div>
            <div class="admin-report-actions">
              <button type="button" class="ghost admin-img-act" data-act="approve">Approve</button>
              <button type="button" class="ghost admin-img-act" data-act="reject">Reject</button>
            </div>
          </div>`).join('')}</div>
      ` : `<div class="empty">No images awaiting review.</div>`;
      document.querySelectorAll('.admin-report-row[data-media-id]').forEach(row => {
        const mediaId = row.dataset.mediaId;
        const approveBtn = row.querySelector('[data-act="approve"]');
        if (approveBtn) approveBtn.onclick = async () => {
          try { await api('/api/admin/images/' + mediaId + '/approve', { method: 'POST' }); openAdminDashboard('images'); }
          catch (e) { alert(e.message); }
        };
        const rejectBtn = row.querySelector('[data-act="reject"]');
        if (rejectBtn) rejectBtn.onclick = async () => {
          const note = prompt('Optional reason (shown to the poster):') || '';
          if (!confirm('Reject and remove this image?')) return;
          try {
            await api('/api/admin/images/' + mediaId + '/reject', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note }) });
            openAdminDashboard('images');
          } catch (e) { alert(e.message); }
        };
      });
    } catch (e) {
      $('#adminTabContent').innerHTML = `<div class="empty">Could not load flagged images.</div>`;
    }
    return;
  }

  if (tab === 'log') {
    try {
      const rows = await api('/api/admin/moderation-log');
      $('#adminTabContent').innerHTML = rows.length ? `
        <div class="admin-log">${rows.map(r => `
          <div class="admin-log-row">
            <div><strong>${escapeHtml(r.action.replace(/_/g, ' '))}</strong> · ${escapeHtml(r.target_type)} <span class="hint">by ${escapeHtml(r.admin_name)}</span></div>
            ${r.note ? `<div class="hint">"${escapeHtml(r.note)}"</div>` : ''}
            <div class="hint">${escapeHtml(r.created_at)}</div>
          </div>`).join('')}</div>
      ` : `<div class="empty">No moderation actions yet.</div>`;
    } catch (e) {
      $('#adminTabContent').innerHTML = `<div class="empty">Could not load moderation history.</div>`;
    }
    return;
  }

  try {
    const reports = await api('/api/admin/reports?status=' + encodeURIComponent(statusFilter));
    $('#adminTabContent').innerHTML = `
      <div class="admin-status-filter">
        ${['open', 'resolved', 'dismissed'].map(s => `<button class="chip status-chip ${s === statusFilter ? 'active' : ''}" data-status="${s}">${REPORT_STATUS_LABELS[s]}</button>`).join('')}
      </div>
      ${reports.length ? `<div class="admin-reports">${reports.map(r => `
        <div class="admin-report-row" data-id="${r.id}">
          <div><strong>${escapeHtml(REPORT_LABELS[r.target_type] || r.target_type)}</strong>: ${escapeHtml(r.target.label)} ${r.target.status ? `<span class="hint">(${escapeHtml(r.target.status)})</span>` : ''}</div>
          <div class="hint">Reported by ${escapeHtml(r.reporter_name)} · ${escapeHtml(r.created_at)}</div>
          <p class="review-comment">"${escapeHtml(r.reason)}"</p>
          ${r.status !== 'open' ? `<div class="hint">${REPORT_STATUS_LABELS[r.status]}${r.resolution_note ? ': "' + escapeHtml(r.resolution_note) + '"' : ''}</div>` : `
          <div class="admin-report-actions">
            <button type="button" class="ghost admin-act" data-act="resolve">Resolve</button>
            <button type="button" class="ghost admin-act" data-act="dismiss">Dismiss</button>
            ${r.target_type === 'item' ? `<button type="button" class="ghost admin-act" data-act="close_item">Close listing</button>` : ''}
            ${r.target_type === 'request' ? `<button type="button" class="ghost admin-act" data-act="close_request">Close listing</button>` : ''}
            ${(r.target_type === 'user' || r.target_type === 'rating') && r.target.owner_id ? `<button type="button" class="ghost admin-act" data-act="ban">Ban user</button>` : ''}
          </div>`}
        </div>`).join('')}</div>` : `<div class="empty">No ${statusFilter} reports.</div>`}
    `;
    document.querySelectorAll('.status-chip').forEach(chip => chip.onclick = () => openAdminDashboard('reports', chip.dataset.status));
    reports.forEach(r => {
      const row = document.querySelector(`.admin-report-row[data-id="${r.id}"]`);
      if (!row) return;
      const closeBtn = row.querySelector('[data-act="close_item"], [data-act="close_request"]');
      if (closeBtn) closeBtn.onclick = async () => {
        try {
          const path = r.target_type === 'item' ? '/api/admin/items/' + r.target_id + '/close' : '/api/admin/requests/' + r.target_id + '/close';
          await api(path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note: 'Closed via report ' + r.id }) });
          alert('Listing closed.');
          openAdminDashboard('reports', statusFilter);
        } catch (e) { alert(e.message); }
      };
      const banBtn = row.querySelector('[data-act="ban"]');
      if (banBtn) banBtn.onclick = async () => {
        const reason = prompt('Reason for ban (shown to the user):') || '';
        if (!confirm('Ban this user? This immediately revokes their active session.')) return;
        try {
          await api('/api/admin/users/' + r.target.owner_id + '/ban', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) });
          alert('User banned.');
          openAdminDashboard('reports', statusFilter);
        } catch (e) { alert(e.message); }
      };
      const resolveBtn = row.querySelector('[data-act="resolve"]');
      if (resolveBtn) resolveBtn.onclick = async () => {
        const note = prompt('Optional note for this resolution:') || '';
        try {
          await api('/api/admin/reports/' + r.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'resolved', note }) });
          openAdminDashboard('reports', statusFilter);
        } catch (e) { alert(e.message); }
      };
      const dismissBtn = row.querySelector('[data-act="dismiss"]');
      if (dismissBtn) dismissBtn.onclick = async () => {
        const note = prompt('Optional note for this resolution:') || '';
        try {
          await api('/api/admin/reports/' + r.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'dismissed', note }) });
          openAdminDashboard('reports', statusFilter);
        } catch (e) { alert(e.message); }
      };
    });
    if (window.lucide) lucide.createIcons();
  } catch (e) {
    $('#adminTabContent').innerHTML = `<div class="empty">Could not load reports.</div>`;
  }
}

// ---------- trust: verification (demo OTP) ----------
async function openVerifyModal() {
  showModal(`<h2>Verify your account</h2><div id="verifyContent">Loading...</div>`);
  const { demo_code } = await api('/api/verify/request', { method: 'POST' });
  $('#verifyContent').innerHTML = `
    <p class="hint">DEMO MODE: in production this code would be sent via SMS/email. Your code is <strong>${demo_code}</strong> — enter it below to confirm.</p>
    <form id="verifyForm">
      <label>6-digit code</label><input name="code" required maxlength="6" pattern="[0-9]{6}">
      <div class="error" id="verifyError"></div>
      <button class="primary-btn" type="submit">Confirm</button>
    </form>
  `;
  $('#verifyForm').onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    try {
      await api('/api/verify/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fd) });
      state.user.is_verified = 1;
      closeModal();
      renderNav();
      alert("You're verified! A ✓ Verified badge now shows on your posts.");
    } catch (err) { $('#verifyError').textContent = err.message; }
  };
}

// ---------- impact metrics ----------
async function openImpactModal() {
  showModal(`<h2>Our impact</h2><p class="hint">Live numbers from ReUse Hub — "Nothing useful should go to waste."</p><div id="impactContent">Loading...</div>`);
  const stats = await api('/api/impact');
  $('#impactContent').innerHTML = `<div class="impact-grid">
    <div class="impact-stat"><div class="num">${stats.total_users}</div><div class="label">Registered users</div></div>
    <div class="impact-stat"><div class="num">${stats.active_today}</div><div class="label">Active today</div></div>
    <div class="impact-stat"><div class="num">${stats.verified_users}</div><div class="label">Verified users</div></div>
    <div class="impact-stat"><div class="num">${stats.completed_requests}</div><div class="label">Completed requests</div></div>
    <div class="impact-stat"><div class="num">${stats.reused_items}</div><div class="label">Items reused</div></div>
    <div class="impact-stat"><div class="num">${stats.waste_diverted_listings}</div><div class="label">Waste diverted (listings)</div></div>
    <div class="impact-stat"><div class="num">${stats.avg_response_hours != null ? stats.avg_response_hours + 'h' : '—'}</div><div class="label">Avg. response time</div></div>
    <div class="impact-stat"><div class="num">${stats.repeat_users}</div><div class="label">Repeat users</div></div>
  </div>`;
}

// ---------- notifications ----------
// ---------- notification panel (V1) ----------
// Icons/labels purely cosmetic — the type string itself still drives nothing except which icon
// shows; routing is driven by target_type/target_id from the server, not by parsing this map.
const NOTIF_ICONS = {
  new_request: '🔔', request_accepted: '✅', request_declined: '❌',
  exchange_confirmed: '⏳', exchange_completed: '🎉', exchange_not_completed: '⚠️',
  new_offer: '🔔', offer_accepted: '✅', offer_declined: '❌',
  rating_received: '⭐'
};
// Which Activity tab a claim/offer-targeted notification should land on. Not always exactly
// right (e.g. an exchange_confirmed notification could apply to either side), but it gets the
// user into the right general area — they can switch tabs from there.
const NOTIF_CLAIM_TAB = { new_request: 'tabItemsReceived', request_accepted: 'tabItemsSent', request_declined: 'tabItemsSent' };
const NOTIF_OFFER_TAB = { new_offer: 'tabOffersReceived', offer_accepted: 'tabOffersSent', offer_declined: 'tabOffersSent' };

function timeAgo(isoLike) {
  const then = new Date(isoLike.replace(' ', 'T') + 'Z').getTime();
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

async function toggleNotifPanel() {
  const panel = $('#notifPanel');
  if (!panel) return;
  const opening = panel.style.display === 'none';
  if (!opening) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  panel.innerHTML = `<div class="hint" style="padding:14px">Loading...</div>`;
  const notifs = await api('/api/notifications');
  renderNotifPanel(notifs);
}

function closeNotifPanel() {
  const panel = $('#notifPanel');
  if (panel) panel.style.display = 'none';
}

function renderNotifPanel(notifs) {
  const panel = $('#notifPanel');
  if (!panel) return;
  panel.innerHTML = `
    <div class="notif-panel-head">
      <strong>Notifications</strong>
      ${notifs.some(n => !n.is_read) ? `<button type="button" class="notif-markall" id="notifMarkAll">Mark all as read</button>` : ''}
    </div>
    <div class="notif-list">
      ${notifs.length ? notifs.map(n => `
        <div class="notif-row ${n.is_read ? '' : 'unread'}" data-id="${n.id}" data-type="${n.type}" data-target-type="${n.target_type || ''}" data-target-id="${n.target_id || ''}">
          <span class="notif-icon">${NOTIF_ICONS[n.type] || '🔔'}</span>
          <div class="notif-body">
            <div class="notif-msg">${escapeHtml(n.message)}</div>
            <div class="hint">${timeAgo(n.created_at)}</div>
          </div>
        </div>
      `).join('') : `<div class="empty-state" style="padding:32px 16px"><div class="empty-state-icon">🔔</div><p>No notifications yet — you'll see updates on your requests and exchanges here.</p></div>`}
    </div>
  `;
  if (window.lucide) lucide.createIcons();
  const markAll = $('#notifMarkAll');
  if (markAll) markAll.onclick = async (e) => {
    e.stopPropagation();
    await api('/api/notifications/mark-all-read', { method: 'POST' });
    panel.querySelectorAll('.notif-row.unread').forEach(r => r.classList.remove('unread'));
    markAll.remove();
    refreshNotifCount();
  };
  panel.querySelectorAll('.notif-row[data-id]').forEach(row => {
    row.onclick = async (e) => {
      e.stopPropagation();
      const id = row.dataset.id;
      if (row.classList.contains('unread')) {
        row.classList.remove('unread');
        try { await api('/api/notifications/' + id + '/read', { method: 'POST' }); } catch (e2) { /* non-fatal */ }
        refreshNotifCount();
      }
      closeNotifPanel();
      handleNotifClick(row.dataset.targetType, row.dataset.targetId, row.dataset.type);
    };
  });
}

function handleNotifClick(targetType, targetId, notifType) {
  if (!targetType || !targetId) return;
  if (targetType === 'item') return openDetail(targetId);
  if (targetType === 'request') return openRequestDetail(targetId);
  if (targetType === 'user') return openProfileModal(targetId);
  if (targetType === 'claim') return openActivity(NOTIF_CLAIM_TAB[notifType] || 'tabItemsReceived');
  if (targetType === 'offer') return openActivity(NOTIF_OFFER_TAB[notifType] || 'tabOffersReceived');
}

// ---------- public user profile (V1 trust system) ----------
// Keep in sync with server.js RATING_TAGS — used both to render checkboxes on the rating prompt
// and to turn a submitted tag key back into a readable label on someone's profile.
const RATING_TAGS = [
  { key: 'good_communication', label: 'Good communication' },
  { key: 'item_as_described', label: 'Item as described' },
  { key: 'smooth_handover', label: 'Smooth handover' }
];
const PROFILE_BADGE_LABELS = { food_giver: '🍲 Top Food Giver', reuse_donor: '♻️ Top Reuse Donor', community_champion: '🌱 Community Champion' };

function starsDisplayHtml(avgRating) {
  if (avgRating == null) return `<span class="hint">No ratings yet</span>`;
  const full = Math.round(avgRating);
  return `<span class="stars-display">${'★'.repeat(full)}${'☆'.repeat(5 - full)}</span> <strong>${avgRating}</strong>`;
}

function tagLabel(key) { return (RATING_TAGS.find(t => t.key === key) || {}).label || key; }

async function openProfileModal(userId) {
  if (!userId) return;
  showModal(`<h2>Profile</h2><div id="profileContent">Loading...</div>`);
  try {
    const p = await api('/api/users/' + userId + '/profile');
    $('#profileContent').innerHTML = `
      <div class="profile-header">
        <div class="profile-name">${escapeHtml(p.name)}${p.is_verified ? ` <span class="owner-check" title="Verified">${CHECK_SVG}</span>` : ''} ${p.account_type === 'business' ? '<span class="owner-badge">Business</span>' : '<span class="owner-badge">Individual</span>'}</div>
        <div class="hint">📍 ${escapeHtml(p.location || 'Location not set')}</div>
        <div class="hint">${p.member_since ? 'Member since ' + escapeHtml(p.member_since) : ''}</div>
      </div>
      <div class="profile-rating">${starsDisplayHtml(p.avg_rating)}${p.rating_count ? ` <span class="hint">(${p.rating_count} review${p.rating_count === 1 ? '' : 's'})</span>` : ''}</div>
      ${p.badges.length ? `<div class="profile-badges">${p.badges.map(b => `<span class="mini-badge-lg">${PROFILE_BADGE_LABELS[b] || b}</span>`).join(' ')} <span class="hint">· ${escapeHtml(p.badge_month)}</span></div>` : ''}
      <div class="profile-stats">
        <div class="profile-stat"><div class="num">${p.reuse_count}</div><div class="label">Successful reuses</div></div>
        <div class="profile-stat"><div class="num">${p.food_count}</div><div class="label">Food donations</div></div>
        <div class="profile-stat"><div class="num">${p.total_count}</div><div class="label">Total contributions</div></div>
      </div>
      ${state.user && state.user.id !== p.id ? `<a href="#" class="report-link" id="reportUserLink">🚩 Report this user</a>` : ''}
      <h3 style="margin-top:18px">Recent reviews</h3>
      <div class="hint" style="margin-bottom:8px">Reviewer identities are kept anonymous.</div>
      ${p.recent_reviews.length ? p.recent_reviews.map(r => `
        <div class="review-row">
          <div class="stars-display">${'★'.repeat(r.stars)}${'☆'.repeat(5 - r.stars)}</div>
          ${r.tags.length ? `<div class="review-tags">${r.tags.map(t => `<span class="badge">${escapeHtml(tagLabel(t))}</span>`).join(' ')}</div>` : ''}
          ${r.comment ? `<p class="review-comment">"${escapeHtml(r.comment)}"</p>` : ''}
          ${state.user ? `<a href="#" class="report-link report-review-link" data-rid="${r.id}">🚩 Report review</a>` : ''}
        </div>`).join('') : `<div class="empty">No reviews yet.</div>`}
    `;
    if (window.lucide) lucide.createIcons();
    const reportUserLink = $('#reportUserLink');
    if (reportUserLink) reportUserLink.onclick = (e) => { e.preventDefault(); openReportModal('user', p.id); };
    document.querySelectorAll('.report-review-link').forEach(link => {
      link.onclick = (e) => { e.preventDefault(); openReportModal('rating', link.dataset.rid); };
    });
  } catch (e) {
    $('#profileContent').innerHTML = `<div class="empty">Could not load this profile.</div>`;
  }
}

// ---------- rating submission (attaches to a completed claim/offer in the Activity dashboard) ----------
function ratingPromptHtml(row, kind, ratedSet) {
  if (row.status !== 'completed') return '';
  if (ratedSet.has(`${kind}:${row.id}`)) return `<div class="hint rating-done">⭐ Thanks — you rated this exchange.</div>`;
  return `<div class="rating-prompt" data-kind="${kind}" data-cid="${row.id}">
    <div class="hint">Rate this exchange</div>
    <div class="star-picker" role="group" aria-label="Star rating">
      ${[1, 2, 3, 4, 5].map(n => `<button type="button" class="star-pick" data-n="${n}" aria-label="${n} star${n === 1 ? '' : 's'}">☆</button>`).join('')}
    </div>
    <div class="rating-tags">
      ${RATING_TAGS.map(t => `<label class="tag-check"><input type="checkbox" value="${t.key}"> ${escapeHtml(t.label)}</label>`).join('')}
    </div>
    <textarea class="rating-comment" maxlength="500" placeholder="Optional comment (kept anonymous)"></textarea>
    <button type="button" class="primary-btn rating-submit" disabled>Submit rating</button>
    <div class="error rating-error"></div>
  </div>`;
}

function bindRatingPrompts(el, onDone) {
  el.querySelectorAll('.rating-prompt').forEach(box => {
    let selected = 0;
    const stars = [...box.querySelectorAll('.star-pick')];
    const submitBtn = box.querySelector('.rating-submit');
    stars.forEach(s => s.onclick = () => {
      selected = parseInt(s.dataset.n, 10);
      stars.forEach(x => x.textContent = parseInt(x.dataset.n, 10) <= selected ? '★' : '☆');
      submitBtn.disabled = false;
    });
    submitBtn.onclick = async () => {
      const tags = [...box.querySelectorAll('.tag-check input:checked')].map(i => i.value);
      const comment = box.querySelector('.rating-comment').value.trim();
      submitBtn.disabled = true;
      try {
        await api('/api/ratings', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ exchange_type: box.dataset.kind, exchange_id: box.dataset.cid, stars: selected, tags, comment })
        });
        onDone();
      } catch (e) {
        box.querySelector('.rating-error').textContent = e.message;
        submitBtn.disabled = false;
      }
    };
  });
}

// ---------- my posts (items + requests) ----------
async function openMyPosts() {
  const [items, requests] = await Promise.all([
    api('/api/items?mine=' + state.user.id),
    api('/api/requests?mine=' + state.user.id)
  ]);
  showModal(`
    <h2>My posts</h2>
    <h3 style="font-size:14px;color:var(--muted);margin:16px 0 8px">Give &amp; take / Business recycle</h3>
    ${items.length ? `<div class="grid">${items.map(cardHtml).join('')}</div>` : `<div class="empty">Nothing posted here yet.</div>`}
    <h3 style="font-size:14px;color:var(--muted);margin:20px 0 8px">Requests (things &amp; services you need)</h3>
    ${requests.length ? `<div class="grid">${requests.map(requestCardHtml).join('')}</div>` : `<div class="empty">Nothing posted here yet.</div>`}
  `);
  document.querySelectorAll('#modalRoot .grid')[0]?.querySelectorAll('.card').forEach(c => c.onclick = () => { closeModal(); openDetail(c.dataset.id); });
  document.querySelectorAll('#modalRoot .grid')[1]?.querySelectorAll('.card').forEach(c => c.onclick = () => { closeModal(); openRequestDetail(c.dataset.id); });
}

// ---------- two-sided completion confirmation ----------
// Real completed exchanges only — no points/XP/levels. Only counts once BOTH sides confirm.
const NOT_COMPLETED_REASONS = ['Pickup did not happen', 'Item/food was unavailable', 'Could not contact the other person', 'Other'];

function confirmBlockHtml(row, role, kind) {
  if (row.status === 'completed') return `<div class="hint confirm-done">✅ Completed${row.completed_at ? ' · ' + escapeHtml(row.completed_at.slice(0, 10)) : ''}</div>`;
  if (row.status === 'not_completed') return `<div class="hint">Not completed${row.not_completed_reason ? ' · ' + escapeHtml(row.not_completed_reason) : ''}</div>`;
  if (row.status !== 'accepted') return '';
  const myConfirmed = role === 'giver' ? row.giver_confirmed : row.receiver_confirmed;
  if (myConfirmed) return `<div class="hint">Waiting for the other participant to confirm.</div>`;
  const question = role === 'giver' ? 'Was this item successfully handed over?' : 'Did you successfully receive this item?';
  const yesLabel = role === 'giver' ? 'Yes, completed' : 'Yes, received';
  const noLabel = role === 'giver' ? 'No, not completed' : 'No, not received';
  return `<div class="confirm-block" data-kind="${kind}" data-cid="${row.id}">
    <div class="hint">${question}</div>
    <div class="actions">
      <button type="button" class="accept confirm-yes">${yesLabel}</button>
      <button type="button" class="decline confirm-no">${noLabel}</button>
    </div>
    <div class="confirm-reason" style="display:none">
      <select class="reason-select">${NOT_COMPLETED_REASONS.map(r => `<option>${r}</option>`).join('')}</select>
      <button type="button" class="decline confirm-no-submit">Submit</button>
    </div>
  </div>`;
}

function bindConfirmBlocks(el, onDone) {
  el.querySelectorAll('.confirm-block').forEach(block => {
    const kind = block.dataset.kind, id = block.dataset.cid;
    const url = `/api/${kind === 'claim' ? 'claims' : 'request-offers'}/${id}/confirm`;
    block.querySelector('.confirm-yes').onclick = async () => {
      await api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed: true }) });
      onDone();
    };
    block.querySelector('.confirm-no').onclick = () => {
      block.querySelector('.actions').style.display = 'none';
      block.querySelector('.confirm-reason').style.display = 'flex';
    };
    block.querySelector('.confirm-no-submit').onclick = async () => {
      const reason = block.querySelector('.reason-select').value;
      await api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed: false, reason }) });
      onDone();
    };
  });
}

// ---------- activity dashboard (claims + request offers) ----------
async function openActivity(initialTab) {
  showModal(`
    <h2>Activity</h2>
    <div class="tabs">
      <button class="active" id="tabItemsReceived">Item requests received</button>
      <button id="tabItemsSent">Item requests sent</button>
      <button id="tabOffersReceived">Offers to help received</button>
      <button id="tabOffersSent">Offers to help sent</button>
    </div>
    <div id="reqContent"></div>
  `);
  ['tabItemsReceived', 'tabItemsSent', 'tabOffersReceived', 'tabOffersSent'].forEach(id => {
    $('#' + id).onclick = () => setActivityTab(id);
  });
  setActivityTab(initialTab && $('#' + initialTab) ? initialTab : 'tabItemsReceived');
}

async function setActivityTab(tabId) {
  ['tabItemsReceived', 'tabItemsSent', 'tabOffersReceived', 'tabOffersSent'].forEach(id => {
    $('#' + id).classList.toggle('active', id === tabId);
  });
  const el = $('#reqContent');
  el.innerHTML = 'Loading...';
  // Fetched once per tab render so ratingPromptHtml knows which completed exchanges this user has
  // already rated and can hide the prompt for those — cheap query, no need to cache across tabs.
  const ratedSet = new Set(state.user ? await api('/api/ratings/my-submitted') : []);

  if (tabId === 'tabItemsReceived') {
    const claims = await api('/api/my/claims-received');
    el.innerHTML = claims.length ? claims.map(c => `
      <div class="claim-row">
        <strong>${escapeHtml(c.item_title)}</strong> — from <button type="button" class="owner-name-link" data-uid="${escapeHtml(c.requester_id)}">${escapeHtml(c.requester_name)}</button> (${escapeHtml(c.requester_email)})
        <div class="hint">${escapeHtml(c.message || 'No message')}</div>
        <div class="hint">Status: ${c.status}</div>
        ${c.status === 'pending' ? `<div class="actions">
          <button class="accept" data-id="${c.id}" data-status="accepted">Accept</button>
          <button class="decline" data-id="${c.id}" data-status="declined">Decline</button>
        </div>` : ''}
        ${confirmBlockHtml(c, 'giver', 'claim')}
        ${ratingPromptHtml(c, 'claim', ratedSet)}
      </div>`).join('') : `<div class="empty">No requests received yet.</div>`;
    el.querySelectorAll('button[data-id]').forEach(b => b.onclick = async () => {
      await api('/api/claims/' + b.dataset.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: b.dataset.status }) });
      setActivityTab('tabItemsReceived');
      loadItems();
    });
    bindConfirmBlocks(el, () => { setActivityTab('tabItemsReceived'); loadItems(); loadMonthlyBadges(); });
    bindRatingPrompts(el, () => { setActivityTab('tabItemsReceived'); });
  } else if (tabId === 'tabItemsSent') {
    const claims = await api('/api/my/claims-sent');
    el.innerHTML = claims.length ? claims.map(c => `
      <div class="claim-row">
        <strong>${escapeHtml(c.item_title)}</strong>
        <div class="hint">Your request status: ${c.status} · Item status: ${c.item_status}</div>
        ${confirmBlockHtml(c, 'receiver', 'claim')}
        ${ratingPromptHtml(c, 'claim', ratedSet)}
      </div>`).join('') : `<div class="empty">You haven't requested anything yet.</div>`;
    bindConfirmBlocks(el, () => { setActivityTab('tabItemsSent'); loadItems(); loadMonthlyBadges(); });
    bindRatingPrompts(el, () => { setActivityTab('tabItemsSent'); });
  } else if (tabId === 'tabOffersReceived') {
    const offers = await api('/api/my/request-offers-received');
    el.innerHTML = offers.length ? offers.map(o => `
      <div class="claim-row">
        <strong>${escapeHtml(o.request_title)}</strong> — from <button type="button" class="owner-name-link" data-uid="${escapeHtml(o.responder_id)}">${escapeHtml(o.responder_name)}</button> (${escapeHtml(o.responder_email)})
        <div class="hint">${escapeHtml(o.message || 'No message')}${o.offered_price ? ' · Offered ₹' + o.offered_price : ''}</div>
        <div class="hint">Status: ${o.status}</div>
        ${o.status === 'pending' ? `<div class="actions">
          <button class="accept" data-id="${o.id}" data-status="accepted">Accept</button>
          <button class="decline" data-id="${o.id}" data-status="declined">Decline</button>
        </div>` : ''}
        ${o.pickup_area ? `<div class="hint">📍 ${escapeHtml(o.pickup_area)}</div>` : ''}
        ${exactPickupHtml(o)}
        ${confirmBlockHtml(o, 'receiver', 'offer')}
        ${ratingPromptHtml(o, 'offer', ratedSet)}
      </div>`).join('') : `<div class="empty">No offers received yet.</div>`;
    bindCopyButtons(el);
    el.querySelectorAll('button[data-id]').forEach(b => b.onclick = async () => {
      await api('/api/request-offers/' + b.dataset.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: b.dataset.status }) });
      setActivityTab('tabOffersReceived');
      loadRequests();
    });
    bindConfirmBlocks(el, () => { setActivityTab('tabOffersReceived'); loadRequests(); loadMonthlyBadges(); });
    bindRatingPrompts(el, () => { setActivityTab('tabOffersReceived'); });
  } else {
    const offers = await api('/api/my/request-offers-sent');
    el.innerHTML = offers.length ? offers.map(o => `
      <div class="claim-row">
        <strong>${escapeHtml(o.request_title)}</strong>
        <div class="hint">Your offer status: ${o.status} · Request status: ${o.request_status}</div>
        ${o.pickup_area ? `<div class="hint">📍 ${escapeHtml(o.pickup_area)}</div>` : ''}
        ${confirmBlockHtml(o, 'giver', 'offer')}
        ${ratingPromptHtml(o, 'offer', ratedSet)}
      </div>`).join('') : `<div class="empty">You haven't offered to help with anything yet.</div>`;
    bindConfirmBlocks(el, () => { setActivityTab('tabOffersSent'); loadRequests(); loadMonthlyBadges(); });
    bindRatingPrompts(el, () => { setActivityTab('tabOffersSent'); });
  }
}

init();
