const state = {
  user: null, categories: [], businessCategories: [], serviceCategories: [],
  // How many of the (now priority-ordered) businessCategories entries show immediately in the
  // Business Surplus sidebar before a "More categories" toggle reveals the specialized/waste-stream
  // rest. Comes from GET /api/me so the frontend never hardcodes the split. showAllBusinessCategories
  // is purely a UI expand/collapse flag, reset whenever the section is switched.
  businessCategoriesPrimaryCount: 0, showAllBusinessCategories: false,
  section: 'consumer', requestType: 'thing', urgentOnly: false, sort: '',
  items: [], requests: [], category: '', priceType: '', q: '', location: '',
  // PHASE 7: pagination UI state for the "Load more" button — itemsPage/requestsPage track the next
  // page to request, itemsHasMore/requestsHasMore mirror the backend's hasMore flag from Phase 6's
  // opt-in pagination response shape ({ items/requests, page, limit, total, hasMore }).
  itemsPage: 1, requestsPage: 1, itemsHasMore: false, requestsHasMore: false,
  wishlist: loadWishlistFromStorage(), monthlyBadges: null,
  // Cached once after login from the existing GET /api/users/:id/profile endpoint, purely to show
  // "Member since ..." in the profile dropdown header. Not a new data source or duplicated field.
  myMemberSince: null,
  // Mobile-only Home/Browse split (nav redesign Stage 3) — desktop never reads this; it always
  // shows the single continuous page it always has. 'home' = curated homepage (Trending preview,
  // People asking for help, Champions, compact Impact card). 'browse' = full categories + grid.
  view: 'home'
};

// Saved Items (wishlist) persistence. Previously state.wishlist was a plain in-memory Set with
// nothing writing it to disk, so every saved item vanished on refresh/reopen — this was the #1
// easy-fix gap vs. popular marketplace apps, which all keep "saved"/"liked" items across sessions.
// localStorage (not a server table) is intentional for this pass: it's a one-line read/write, needs
// no new API route or DB table, and covers the real complaint (survives a refresh) even though it
// won't follow the user to a different browser/device — that upgrade can come later if needed.
const WISHLIST_STORAGE_KEY = 'zineedo_wishlist';
function loadWishlistFromStorage() {
  try {
    const raw = localStorage.getItem(WISHLIST_STORAGE_KEY);
    const ids = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(ids) ? ids : []);
  } catch {
    // Corrupted/blocked storage (private browsing, quota, bad JSON) — fail open to an empty
    // wishlist rather than breaking the whole app on load.
    return new Set();
  }
}
function saveWishlistToStorage() {
  try {
    localStorage.setItem(WISHLIST_STORAGE_KEY, JSON.stringify([...state.wishlist]));
  } catch {
    // Storage unavailable/full — saved items just won't persist this session; not worth surfacing
    // an error to the user for a non-critical feature.
  }
}

const SECTION_HINTS = {
  consumer: "Give. Find. Reuse. Give away things you no longer need, or find useful items near you.",
  business_waste: "Reusable surplus from businesses — office furniture, electronics, machinery, packaging, metal scrap, construction materials and more. Help reduce waste and build a sustainable future.",
  requests: "Post what you NEED instead of what you have — a thing or a service — and let nearby people fulfill it for free, rent, or payment."
};

const $ = sel => document.querySelector(sel);
const modalRoot = $('#modalRoot');
const lightboxRoot = $('#lightboxRoot');

// PHASE 7 MOBILE AUDIT FIX: showModal()/closeModal() back every major modal in the app (auth,
// post item/request, edit item/request, claims/offers, ratings, the profile sheet, admin panels,
// the location picker, etc.) but had NO Escape-to-close handling at all (unlike the notification
// panel, category dropdown, user menu, and filter panel, which already all handle Escape) and never
// locked background scroll while open. Both are fixed once, centrally, here — every caller gets the
// fix automatically, nothing about individual modal call sites changes. Guards against the several
// existing "closeModal(); openXyz();" call sequences in this file re-showing a modal immediately
// (removeEventListener before re-adding avoids a duplicate listener; the scroll lock is idempotent).
function modalEscapeHandler(e) { if (e.key === 'Escape') closeModal(); }
function closeModal() {
  modalRoot.innerHTML = '';
  document.removeEventListener('keydown', modalEscapeHandler);
  document.body.style.overflow = '';
}

// ---------- toast notifications ----------
// Lightweight on-screen confirmation (e.g. "Your item was posted!") — separate from the modal
// system above, since a toast must stay visible briefly AFTER a modal closes, not live inside it.
// Stacks multiple toasts if triggered in quick succession rather than replacing one another.
let toastContainer = null;
function showToast(message, type) {
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.className = 'toast-container';
    document.body.appendChild(toastContainer);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${type || 'success'}`;
  el.textContent = message;
  toastContainer.appendChild(el);
  // Force reflow so the enter transition actually plays instead of the element appearing
  // already in its final state.
  requestAnimationFrame(() => el.classList.add('toast-show'));
  setTimeout(() => {
    el.classList.remove('toast-show');
    setTimeout(() => el.remove(), 250);
  }, 3500);
}

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

function showModal(html, extraClass) {
  modalRoot.innerHTML = `<div class="modal-overlay" id="overlay"><div class="modal${extraClass ? ' ' + extraClass : ''}">
    <button class="close" id="closeModal" aria-label="Close">&times;</button>${html}</div></div>`;
  $('#closeModal').onclick = closeModal;
  $('#overlay').onclick = (e) => { if (e.target.id === 'overlay') closeModal(); };
  // Idempotent: re-showing a new modal over an old one (a few call sites do this) just re-adds the
  // same listener/lock rather than stacking duplicates, since closeModal() always tears both down
  // first and the listener function reference is stable (module-level, not recreated per call).
  document.removeEventListener('keydown', modalEscapeHandler);
  document.addEventListener('keydown', modalEscapeHandler);
  document.body.style.overflow = 'hidden';
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
  state.businessCategoriesPrimaryCount = me.business_categories_primary_count || me.business_categories.length;
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
  bindImpactPanel();
  initHeroCarousel();
  loadMonthlyBadges();
  if (state.user) refreshNotifCount();
  registerServiceWorkerForPush();
  // One-time fetch of member_since for the dropdown header — reuses the same profile endpoint
  // My Profile/My Impact call, just cached once so the header doesn't need its own request.
  if (state.user) {
    api('/api/users/' + state.user.id + '/profile').then(p => {
      state.myMemberSince = p.member_since || null;
      renderNav();
    }).catch(() => {});
  }
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
  checkSharedItemInUrl();
  if (window.lucide) lucide.createIcons();
}

// If the page was opened from a shared listing link (?item=ID, written by bindShareButton), open
// that item's detail modal directly instead of just landing on the homepage — otherwise a shared
// link would silently drop the person it was meant for onto the generic browse page.
function checkSharedItemInUrl() {
  const params = new URLSearchParams(location.search);
  const itemId = params.get('item');
  if (!itemId) return;
  openDetail(itemId).catch(() => {});
  params.delete('item');
  const clean = location.pathname + (params.toString() ? `?${params}` : '') + location.hash;
  history.replaceState(null, '', clean);
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
    // Global-nav safety: Give & Take / Business Surplus / Requests are homepage sections, not
    // separate pages, so if My Posts is currently showing, restore the homepage first — otherwise
    // this would silently update DOM the user can't see instead of visibly navigating anywhere.
    ensureHomepageVisible();
    state.section = btn.dataset.section;
    state.category = ''; state.priceType = ''; state.q = ''; state.urgentOnly = false; state.sort = '';
    state.showAllBusinessCategories = false;
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

// Hero headline text per section — only the Business Surplus one actually changes today (Give &
// Take / Requests keep the existing static "Find useful things near you"); kept as a lookup so the
// swap is data-driven rather than a scattered if/else.
const HERO_HEADLINES = {
  business_waste: 'Find business surplus near you'
};
const DEFAULT_HERO_HEADLINE = 'Find useful things near you';

function applySectionUi() {
  const isRequests = state.section === 'requests';
  $('#sectionHint').textContent = SECTION_HINTS[state.section];
  const isBusiness = state.section === 'business_waste';
  document.querySelector('.hero-banner')?.classList.toggle('hero-business', isBusiness);
  const headlineEl = $('#heroHeadline');
  if (headlineEl) headlineEl.textContent = HERO_HEADLINES[state.section] || DEFAULT_HERO_HEADLINE;
  renderHeroPopular();
  renderHeroBusinessGrid();
  $('#reqTypeTabs').style.display = isRequests ? 'flex' : 'none';
  $('#priceFilter').style.display = isRequests ? 'none' : '';
  $('#trendingSection').innerHTML = '';
  $('#urgentSection').innerHTML = '';
  if ($('#serviceRequestsSection')) $('#serviceRequestsSection').innerHTML = '';
  if ($('#foodRescueHeroSection')) $('#foodRescueHeroSection').innerHTML = '';
  $('#businessSurplusIntro').innerHTML = '';
  $('#communitySection').innerHTML = '';
  $('#businessTeaserSection').innerHTML = '';
  $('#collectionsSection').innerHTML = '';
  $('#businessTeaserPreviewSection').innerHTML = '';
  // The global header CTA is intentionally static "+ Post" now (not context-relabeled) — it opens
  // the same 4-option chooser (Give/Exchange item, Item request, Service request, Business
  // surplus) regardless of which section you're browsing, so posting a request never feels
  // hidden just because you're on the Give & Take tab. See #postBtn's click handler below.
  if (window.lucide) lucide.createIcons();
  renderCategories();
  renderQuickCategories();
  if (isRequests) { loadRequests(); } else { loadItems(); loadTrending(); }
  loadBusinessTeaser();
  loadFoodRescueHero();
  if (state.section === 'consumer') {
    // Homepage order: Food Rescue hero (own dedicated spot, right under the hero banner — see
    // loadFoodRescueHero) -> Urgent Requests -> Trending (tabs) -> Categories+Products+Impact ->
    // Community Story -> Business teaser -> Popular Collections.
    loadUrgentRequests();
    loadServiceRequestsPreview();
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

// Food Rescue is the one feature that actually separates Zineedo from a generic used-goods
// marketplace (OLX/FB Marketplace) — previously it was just another item-card strip buried below
// two other sections, which made it look like just another listing type. Now it gets its own
// dedicated hero-style panel directly under the hero/search, with a purpose-built card (live
// countdown, meals/location at a glance, "I can help" CTA) instead of the generic cardHtml(). Still
// only ever rendered when there's something active — same empty-string-out rule as every other
// conditional homepage section, so it never shows a hollow "nothing here" panel.
async function loadFoodRescueHero() {
  const el = $('#foodRescueHeroSection');
  if (!el) return;
  if (state.section !== 'consumer') { el.innerHTML = ''; return; }
  let items = [];
  try {
    // Scoped to consumer-side listings only — urgent Business Surplus gets its own highlight on
    // the Business Surplus page instead, same split as before.
    items = await api('/api/items/urgent?listing_type=consumer');
  } catch (e) { el.innerHTML = ''; return; }
  if (!items.length) { el.innerHTML = ''; return; }
  const shown = items.slice(0, 8);
  el.innerHTML = `
    <div class="food-rescue-hero">
      <div class="food-rescue-hero-head">
        <div class="food-rescue-hero-title">
          <span class="food-rescue-hero-icon" aria-hidden="true">🍱</span>
          <div>
            <h2>Food Rescue Near You <span class="food-rescue-urgent-pill">URGENT</span></h2>
            <p>Fresh surplus food from restaurants, weddings and events. Help reduce food waste.</p>
          </div>
        </div>
        <button type="button" class="view-all-link food-rescue-viewall" id="foodRescueViewAll">View all food rescue →</button>
      </div>
      <div class="food-rescue-row">${shown.map(foodRescueCardHtml).join('')}</div>
    </div>
  `;
  el.querySelectorAll('.food-rescue-card').forEach(c => c.onclick = () => openDetail(c.dataset.id));
  $('#foodRescueViewAll').onclick = () => openUrgentFoodAllModal(items, '🍱 All food rescue near you');
  if (window.lucide) lucide.createIcons();
}

// "18 min left" / "2 hrs left" / "1 day left" — computed live from the same available_until
// deadline already used for the "food-until-hint" line on the regular item card/detail page, just
// expressed as a countdown instead of a fixed time-of-day (more legible at a glance in a small
// badge). Returns '' when there's no deadline set or it's unparseable, so the badge simply doesn't
// render rather than showing something wrong.
function foodRescueCountdownLabel(availableUntil) {
  if (!availableUntil) return '';
  const end = new Date(availableUntil);
  if (isNaN(end.getTime())) return '';
  const diffMs = end.getTime() - Date.now();
  if (diffMs <= 0) return 'Ending soon';
  const mins = Math.round(diffMs / 60000);
  if (mins < 60) return `${mins} min left`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs === 1 ? '' : 's'} left`;
  const days = Math.round(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} left`;
}

function foodRescueCardHtml(item) {
  const media = (item.media && item.media[0]) || (item.media_url ? { url: item.media_url, thumb_url: item.thumb_url } : null);
  const photoHtml = media
    ? `<img src="${escapeHtml(media.thumb_url || media.url)}" alt="" loading="lazy">`
    : `<span class="thumb-emoji">🍱</span>`;
  const countdown = foodRescueCountdownLabel(item.available_until);
  // quantity is free-text the poster typed in (e.g. "serves 10", "2 trays", or left blank) — shown
  // as-is when present rather than forced into a specific "~N meals" phrasing we can't guarantee
  // every listing actually has.
  // The poster's-initial avatar ("S", "M"...) here read as a confusing unlabeled badge — it wasn't
  // actually conveying anything a visitor needs at a glance. Swapped for the listing's real price
  // using the exact same itemPriceLabel()/itemPriceBadgeClass() helpers the regular item cards
  // already use elsewhere (see thumbInnerHtml/cardHtml) — same backend price_type/price fields, same
  // ₹0-reads-as-Free rule, no new logic and nothing invented. "Posted ... ago" stays, just without
  // the avatar glyph in front of it.
  return `<div class="food-rescue-card" data-id="${item.id}">
    <div class="food-rescue-card-photo">
      ${photoHtml}
      ${countdown ? `<span class="food-rescue-countdown"><i data-lucide="clock" style="width:11px;height:11px"></i> ${escapeHtml(countdown)}</span>` : ''}
    </div>
    <div class="food-rescue-card-body">
      <h3>${escapeHtml(item.title)}</h3>
      <div class="food-rescue-meta">
        ${item.quantity ? `<span><i data-lucide="users" style="width:12px;height:12px"></i> ${escapeHtml(item.quantity)}</span>` : ''}
        <span><i data-lucide="map-pin" style="width:12px;height:12px"></i> ${escapeHtml(item.owner_location || 'Nearby')}</span>
      </div>
      <div class="food-rescue-footer">
        <span class="food-rescue-poster"><span class="food-rescue-price-badge ${itemPriceBadgeClass(item)}">${escapeHtml(itemPriceLabel(item))}</span>Posted ${timeAgo(item.created_at)}</span>
        <span class="food-rescue-cta">I can help →</span>
      </div>
    </div>
  </div>`;
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
// REDESIGN (previous attempt still looked broken per user feedback): the old version built one
// card per *populated* group (home-highlights groups, which are frequently all-empty, plus a
// couple of hardcoded categories) — so on a day with little inventory it could render just one or
// two cards, and no amount of CSS sizing on those few cards looked intentional. The fix here is
// structural, not cosmetic: always render the same fixed set of 8 real marketplace categories
// (every card exists every time, same size, same shape), and let each card's *content* — thumbs,
// real item count — reflect whatever data actually exists, down to zero. A uniform grid of known
// cards can never produce the old "giant empty panel" because no card's size ever depends on how
// much data it has.
// Short descriptions below are static UI copy (what the category is for), not data — exactly like
// a nav label — so they don't violate "use real data only"; the thumbnails and item counts next to
// them are 100% live from /api/items.
const COLLECTION_CATEGORIES = [
  { cat: 'Furniture', icon: '🛋️', desc: 'Sofas, tables, chairs & more' },
  { cat: 'Food (Surplus)', icon: '🍱', desc: 'Share extra food before it goes to waste' },
  { cat: 'Electronics & Phones', icon: '📱', desc: 'Phones, gadgets & accessories' },
  { cat: 'Vehicles', icon: '🚲', desc: 'Bikes, cars & spare parts' },
  { cat: 'Baby & Kids', icon: '🧸', desc: "Toys, gear & kids' essentials" },
  { cat: 'Kitchen & Appliances', icon: '🍳', desc: 'Cookware, appliances & more' },
  { cat: 'Clothing & Accessories', icon: '👕', desc: 'Clothes, shoes & accessories' },
  { cat: 'Books & Media', icon: '📚', desc: 'Books, games & media' }
];

async function loadCollections() {
  const el = $('#collectionsSection');
  if (!el) return;
  if (state.section !== 'consumer') { el.innerHTML = ''; return; }
  try {
    // One request per category, each already scoped+paginated server-side (limit=3 → first 3
    // real items for the thumbnails; `total` → the exact real count, not an estimate).
    const results = await Promise.all(COLLECTION_CATEGORIES.map(c =>
      api('/api/items?listing_type=consumer&limit=3&category=' + encodeURIComponent(c.cat))
    ));
    const cards = COLLECTION_CATEGORIES.map((c, idx) => {
      const r = results[idx] || {};
      const items = r.items || [];
      const total = typeof r.total === 'number' ? r.total : items.length;
      // Always exactly 3 thumb slots so every card is the same shape — a category with fewer than
      // 3 (or 0) real items fills the remainder with the same muted empty-box state used elsewhere
      // on the site (thumbInnerHtml's own no-photo fallback), never a blank/missing cell.
      // Tiny price/urgent chip on each real thumb, reusing the same color-coded classes/labels as
      // every other card on the site (itemPriceLabel/itemPriceBadgeClass) — Urgent takes visual
      // priority over the price chip exactly like it does on the main listing cards.
      const slots = [0, 1, 2].map(i => items[i]
        ? `<div class="mini-thumb" data-id="${items[i].id}">${thumbInnerHtml(items[i])}<span class="mini-thumb-badge ${items[i].is_urgent ? 'urgent' : itemPriceBadgeClass(items[i])}">${items[i].is_urgent ? 'Urgent' : itemPriceLabel(items[i])}</span></div>`
        : `<div class="mini-thumb mini-thumb-empty"><span class="thumb-emoji">${c.icon}</span></div>`);
      const countLabel = total === 0 ? 'No items yet' : `${total} item${total === 1 ? '' : 's'}`;
      return `<div class="collection-card${total === 0 ? ' is-empty' : ''}">
        <div class="collection-card-top">
          <span class="collection-card-icon">${c.icon}</span>
          <div>
            <h3>${escapeHtml(c.cat)}</h3>
            <p class="collection-card-desc">${escapeHtml(c.desc)}</p>
          </div>
        </div>
        <div class="collection-mini-grid">${slots.join('')}</div>
        <div class="collection-card-foot">
          <span class="collection-count">${countLabel}</span>
          <button class="view-all-link" data-cat="${escapeHtml(c.cat)}">View collection →</button>
        </div>
      </div>`;
    }).join('');
    el.innerHTML = `<div class="section-head"><h2><i data-lucide="gift" class="section-icon"></i> Popular collections</h2><button class="view-all-link" id="collectionsViewAll">View all collections →</button></div><div class="collections-grid">${cards}</div>`;
    if (window.lucide) lucide.createIcons();
    el.querySelectorAll('.mini-thumb[data-id]').forEach(t => t.onclick = () => openDetail(t.dataset.id));
    el.querySelectorAll('[data-cat]').forEach(btn => btn.onclick = () => {
      state.category = btn.dataset.cat;
      renderCategories();
      loadItems();
      document.querySelector('#content').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    const viewAllBtn = $('#collectionsViewAll');
    if (viewAllBtn) viewAllBtn.onclick = () => {
      state.category = '';
      renderCategories();
      loadItems();
      document.querySelector('#content').scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
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

// loadBusinessAsideCard() removed — it duplicated the large #businessTeaserSection banner further
// down the page (same headline/action), and its container (#businessAsideCard) has been removed
// from index.html.

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
  { key: 'food', label: '🍱 Food surplus' },
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
    } else if (tab === 'food') {
      // Reuses the existing /api/items category filter with the app's existing 'Food (Surplus)'
      // category value (see isEdibleFoodListing() in server.js) — no new backend endpoint, no new
      // filtering logic, same query mechanism the other tabs already use.
      items = (await api('/api/items?listing_type=' + state.section + '&category=' + encodeURIComponent('Food (Surplus)'))).slice(0, 6);
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
  // works identically for items (Zineedo/Food Rescue/Business Surplus) and Requests.
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
}

// Hero "Popular:" quick-category shortcuts — section-aware now (consumer vs Business Surplus show
// different real categories), but still just the same category filter as the sidebar/quick-row,
// reachable straight from the hero. Rendered fresh on every applySectionUi() call.
const HERO_POPULAR_CONSUMER = [
  { cat: 'Books & Media', label: 'Books' },
  { cat: 'Furniture', label: 'Furniture' },
  { cat: 'Electronics & Phones', label: 'Electronics' },
  { cat: 'Vehicles', label: 'Bicycles' },
  { cat: 'Baby & Kids', label: 'Toys' }
];
// Real, existing business_waste category values only (no invented categories). Food & Organic
// Waste is included and labeled "Food Surplus" here specifically so food stays a highly visible
// shortcut on the Business Surplus hero, per explicit request — it's still the same underlying
// category value/filter, just a friendlier label for this one shortcut button.
const HERO_POPULAR_BUSINESS = [
  { cat: 'Metal Scrap (CNC/Machining)', label: 'Metal Scrap' },
  { cat: 'Food & Organic Waste', label: 'Food Surplus' },
  { cat: 'Packaging Material', label: 'Packaging' },
  { cat: 'Business Equipment & Machinery', label: 'Industrial Machinery' },
  { cat: 'Electronics & IT Equipment', label: 'IT Equipment' },
  { cat: 'Construction Debris', label: 'Construction Materials' }
];
function renderHeroPopular() {
  const row = $('#heroPopularRow');
  if (!row) return;
  const list = state.section === 'business_waste' ? HERO_POPULAR_BUSINESS : HERO_POPULAR_CONSUMER;
  if (state.section === 'requests') { row.innerHTML = ''; return; }
  row.innerHTML = `<span class="hero-popular-label">Popular:</span>` +
    list.map(x => `<button type="button" class="hero-popular-link" data-cat="${escapeHtml(x.cat)}">${escapeHtml(x.label)}</button>`).join('');
  row.querySelectorAll('.hero-popular-link').forEach(btn => btn.onclick = () => {
    state.category = btn.dataset.cat;
    renderCategories();
    renderQuickCategories();
    loadItems();
    document.querySelector('.page-layout')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

// Business Surplus hero — latest direction: a single cohesive collage photo (not category tiles),
// per your explicit request to use the reference image itself rather than sourcing/compositing
// separate stock photos. The asset at /assets/hero/business-surplus-collage.jpg is a crop of the
// exact reference image you provided (the collage + "GOOD MATERIALS BRIGHTER TOMORROWS" text is
// baked into that photo already, cropped clean of any UI chrome from the mockup). This function
// just toggles visibility of that single <img> for business_waste vs. every other section — no
// category tiles, no filtering logic here; the existing Popular row + sidebar categories (both
// already real-category-driven) remain the actual filtering UI, unchanged.
function renderHeroBusinessGrid() {
  const wrap = $('#heroCategoryGrid');
  if (wrap) { wrap.innerHTML = ''; wrap.setAttribute('aria-hidden', 'true'); }
  const photo = $('#heroBusinessPhoto');
  if (!photo) return;
  const isBusiness = state.section === 'business_waste';
  photo.setAttribute('aria-hidden', isBusiness ? 'false' : 'true');
  photo.style.display = isBusiness ? '' : 'none';
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

// ---------- browser push notifications ----------
// Standard VAPID-key conversion: the Push API's subscribe() call requires the server's public key
// as a Uint8Array, but the server hands it over as the usual base64url string — this is the
// well-known snippet for that conversion, no library needed for something this small.
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

// Registered for every visitor (not just logged-in users) so the service worker is already
// installed and ready by the time someone logs in and taps "Enable notifications" — otherwise the
// very first enable attempt would need an extra round trip just to install it first.
async function registerServiceWorkerForPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  try { await navigator.serviceWorker.register('/sw.js'); } catch { /* unsupported browser/context (e.g. non-HTTPS) — push just stays unavailable */ }
}

// Null = push unsupported/not configured, true = this browser has an active subscription on
// Zineedo right now, false = supported but not subscribed. Used to decide the profile menu label.
async function getPushSubscriptionState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return !!sub;
  } catch { return null; }
}

async function enablePushNotifications() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    alert(permission === 'denied'
      ? "Notifications are blocked for Zineedo in your browser settings. You'll need to allow them there first."
      : 'Notification permission was not granted.');
    return false;
  }
  try {
    const { publicKey } = await api('/api/push/vapid-public-key');
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
    }
    await api('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub.toJSON()) });
    return true;
  } catch (err) {
    alert('Could not turn on notifications: ' + (err.message || 'unknown error'));
    return false;
  }
}

async function disablePushNotifications() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await api('/api/push/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) });
      await sub.unsubscribe();
    }
  } catch { /* best-effort — nothing useful to show the user if this fails */ }
}

async function openProfileSheet() {
  if (!state.user) return openAuthModal('login');
  const notifLabel = ($('#notifDot') && $('#notifDot').style.display !== 'none') ? `Notifications (${$('#notifDot').textContent})` : 'Notifications';
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window;
  showModal(`
    <h2>Profile</h2>
    <p class="hint" style="margin-top:-4px">Hi, ${escapeHtml(state.user.name)} ${state.user.account_type === 'business' ? '🏢' : ''}</p>
    <div class="profile-sheet-list">
      <button type="button" class="profile-sheet-item" id="profileSheetNotif">🔔 ${notifLabel}</button>
      ${pushSupported ? '<button type="button" class="profile-sheet-item" id="profileSheetPush">📲 Push notifications — checking…</button>' : ''}
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
  if (pushSupported) {
    const pushBtn = $('#profileSheetPush');
    const setPushLabel = (on) => { pushBtn.textContent = on ? '📲 Push notifications — on (tap to turn off)' : '📲 Turn on push notifications'; };
    getPushSubscriptionState().then((on) => setPushLabel(!!on));
    pushBtn.onclick = async () => {
      pushBtn.disabled = true;
      const currentlyOn = await getPushSubscriptionState();
      if (currentlyOn) {
        await disablePushNotifications();
        setPushLabel(false);
      } else {
        const ok = await enablePushNotifications();
        setPushLabel(ok);
      }
      pushBtn.disabled = false;
    };
  }
}

function bindBottomNav() {
  const bottomNav = $('#bottomNav');
  if (!bottomNav) return;

  $('#bnHomeBtn').onclick = () => {
    // ensureHomepageVisible() runs unconditionally here (not just inside the tab's own click
    // handler below) because when the consumer tab is already marked active — the common case,
    // since My Posts doesn't change section-tab state — the guarded .click() below never fires,
    // so nothing would otherwise restore the homepage if the user is on My Posts.
    ensureHomepageVisible();
    const consumerTab = document.querySelector('.section-tab[data-section="consumer"]');
    if (consumerTab && !consumerTab.classList.contains('active')) consumerTab.click();
    setMobileView('home');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    setBottomNavActive('home');
  };
  $('#bnBrowseBtn').onclick = () => {
    ensureHomepageVisible();
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
  $('#sheetPostFoodBtn').onclick = () => {
    closePostSheet();
    if (!state.user) return openAuthModal('login');
    const tab = document.querySelector('.section-tab[data-section="consumer"]');
    if (tab) tab.click();
    openPostModal({ foodRescue: true });
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
    { key: 'about', icon: 'info', label: 'About Zineedo' }
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
  // given its own visual weight since Impact is one of Zineedo's differentiators.
  const impactCta = `
    <button type="button" class="more-menu-impact-cta" data-more="impact">
      <span class="more-menu-impact-icon"><i data-lucide="leaf"></i></span>
      <span class="more-menu-impact-text"><strong>Our Impact</strong><small>See how we're making a difference</small></span>
      <i data-lucide="chevron-right"></i>
    </button>
  `;
  return `<div class="more-menu-groups">${groups}</div>${impactCta}`;
}
// Every More-menu shortcut below jumps to a homepage section; if My Posts is open that section is
// currently hidden, so restore the homepage first (see ensureHomepageVisible) instead of calling
// scrollIntoView on a display:none element, which succeeds silently but visibly does nothing.
const scrollToSel = (sel) => { ensureHomepageVisible(); const el = document.querySelector(sel); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
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
// stay directly visible/lightweight. There is deliberately no separate "⋮" overflow control here
// (removed) — it used to open this exact same one-item dropdown, which made it a redundant second
// way to reach Log out rather than a real shortcut.
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
          <div class="user-menu-header">
            <span class="user-avatar">${initial}</span>
            <div class="user-menu-header-text">
              <strong>Hi, ${escapeHtml(titleCase(state.user.name))}</strong>
              ${(() => {
                const parts = [];
                if (state.user.location) parts.push(escapeHtml(titleCase(state.user.location)));
                if (state.myMemberSince) parts.push('Member since ' + escapeHtml(state.myMemberSince));
                return parts.length ? `<span>${parts.join(' · ')}</span>` : '';
              })()}
              ${state.user.is_verified ? `<span class="user-menu-verified">${CHECK_SVG} Verified member</span>` : ''}
            </div>
          </div>
          <div class="user-menu-group">
            <div class="user-menu-group-label">Profile</div>
            <button type="button" role="menuitem" id="menuMyProfileBtn"><i data-lucide="user"></i> My Profile</button>
          </div>
          <div class="user-menu-group">
            <div class="user-menu-group-label">Activity</div>
            <button type="button" role="menuitem" id="menuMyPostsBtn"><i data-lucide="package"></i> My Posts</button>
            <button type="button" role="menuitem" id="menuDonatedBtn"><i data-lucide="gift"></i> Donated Items</button>
            <button type="button" role="menuitem" id="menuReceivedBtn"><i data-lucide="package-check"></i> Received Items</button>
            <button type="button" role="menuitem" id="menuExchangesBtn"><i data-lucide="repeat"></i> My Exchanges</button>
            <button type="button" role="menuitem" id="menuSavedBtn"><i data-lucide="heart"></i> Saved Items</button>
            <button type="button" role="menuitem" id="menuImpactBtn"><i data-lucide="sprout"></i> My Impact</button>
            <button type="button" role="menuitem" id="menuActivityBtn"><i data-lucide="activity"></i> Activity</button>
          </div>
          <div class="user-menu-group">
            <div class="user-menu-group-label">Account</div>
            <button type="button" role="menuitem" id="menuNotifBtn"><i data-lucide="bell"></i> Notifications</button>
            <button type="button" role="menuitem" id="menuPasswordBtn"><i data-lucide="lock"></i> Password &amp; Security</button>
            <button type="button" role="menuitem" id="menuBlockedBtn"><i data-lucide="shield-off"></i> Blocked users</button>
            ${state.user.is_admin ? '<button type="button" role="menuitem" id="adminBtn"><i data-lucide="shield"></i> Admin</button>' : ''}
          </div>
          <div class="user-menu-divider"></div>
          <button type="button" role="menuitem" id="logoutBtn" class="danger"><i data-lucide="log-out"></i> Log out</button>
        </div>
      </div>`;
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
    // Dropdown's own quick-access rows reuse the exact same functions as the persistent header
    // icons above — not a second/different My Posts, Activity, or Notifications implementation.
    $('#menuMyProfileBtn').onclick = () => { closeUserMenu(); openMyProfile(); };
    $('#menuMyPostsBtn').onclick = () => { closeUserMenu(); openMyPosts(); };
    // Donated / Received / My Exchanges are not separate pages or data sources -- they open the
    // existing Activity page pre-scrolled to the tab that already holds that real data, exactly
    // like the Activity link below. This avoids duplicating the item/offer-request logic.
    $('#menuDonatedBtn').onclick = () => { closeUserMenu(); openActivity('tabItemsReceived'); };
    $('#menuReceivedBtn').onclick = () => { closeUserMenu(); openActivity('tabItemsSent'); };
    $('#menuExchangesBtn').onclick = () => { closeUserMenu(); openActivity('tabOffersReceived'); };
    $('#menuSavedBtn').onclick = () => { closeUserMenu(); openSavedItemsModal(); };
    $('#menuImpactBtn').onclick = () => { closeUserMenu(); openMyImpactModal(); };
    $('#menuActivityBtn').onclick = () => { closeUserMenu(); openActivity(); };
    $('#menuNotifBtn').onclick = (e) => { e.stopPropagation(); toggleNotifPanel(); closeUserMenu(); };
    $('#menuPasswordBtn').onclick = () => { closeUserMenu(); openChangePasswordModal(); };
    $('#menuBlockedBtn').onclick = () => { closeUserMenu(); openBlockedUsersModal(); };
    // Profile dropdown's outside-click/Escape-to-close behavior is unchanged — it was never
    // specific to the removed overflow button, it belongs to the dropdown itself.
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
  // previously fell back to the generic 'package' icon in the Business Surplus sidebar — filled in
  // so each gets its own distinct icon there and in the Business Surplus hero category grid.
  'Office Furniture & Fixtures': 'sofa', 'Business Equipment & Machinery': 'factory',
  'Electronics & IT Equipment': 'laptop', 'Packaging Material': 'package', 'Retail / Event Surplus': 'store',
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

// Per-category icon tint for the sidebar category list (renderCategories() below) — purely
// decorative, same as the quick-cat-rail comment above, but here the user explicitly asked for a
// distinct color per category instead of one uniform gray, so each gets a fixed muted (non-neon)
// color. Falls back to the existing gray (var(--muted-2), applied in CSS) for anything not listed
// here — never throws for an unmapped category.
const CATEGORY_COLORS = {
  'Education & School Supplies': '#8A63D2', 'Baby & Kids': '#D97A9C', 'Books & Media': '#4A5FC1',
  'Construction Materials': '#B8860B', 'Electronics & Phones': '#3B82C4', 'Computers & Laptops': '#5B6B8C',
  'Furniture': '#B07A4A', 'Vehicles': '#475569', 'Clothing & Accessories': '#2E9E8C',
  'Kitchen & Appliances': '#C2572B', 'Food (Surplus)': '#D9534F', 'Tools & Equipment': '#6B7280',
  'Event Items & Decorations': '#C2458A',
  'Office Furniture & Fixtures': '#B07A4A', 'Business Equipment & Machinery': '#5B6B8C',
  'Electronics & IT Equipment': '#3B82C4', 'Packaging Material': '#8B8F85', 'Retail / Event Surplus': '#C2458A',
  'Toys & Kids': '#D97A9C', 'Baby Products': '#D97A9C',
  'Electrician': '#B8860B', 'Plumber': '#3B82C4', 'Tutor': '#8A63D2', 'Delivery': '#D97A3B',
  'Cleaning': '#2E9E8C', 'Repairs': '#6B7280', 'Design': '#C2458A', 'Photography': '#475569', 'Pet Care': '#B07A4A',
  'Metal Scrap (CNC/Machining)': '#6B7280', 'Wood Scrap & Sawdust': '#B07A4A', 'Cow Dung & Manure': '#7A8F4A',
  'Used Cooking Oil': '#C2572B', 'Food & Organic Waste': '#D9534F', 'Fabric & Textile Scrap': '#2E9E8C',
  'Paper & Cardboard Waste': '#8A63D2', 'Plastic Scrap': '#3B82C4', 'Construction Debris': '#B8860B',
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
// Food (Surplus) and Construction Materials are core Zineedo categories — guaranteed a slot in the
// shortcut row (not just whichever happens to land in the first N) even if CATEGORIES is ever
// reordered. Same underlying state.category / filtering logic either way, just which chips render.
const PRIORITY_CATEGORIES = ['Food (Surplus)', 'Construction Materials'];
function renderQuickCategories() {
  const row = $('#quickCategoriesRow');
  if (!row) return;
  if (state.section !== 'consumer') { row.innerHTML = ''; return; }
  const all = activeCategoryList();
  let cats = all.slice(0, QUICK_CAT_VISIBLE);
  const missingPriority = PRIORITY_CATEGORIES.filter(c => all.includes(c) && !cats.includes(c));
  if (missingPriority.length) {
    const keep = cats.filter(c => !missingPriority.includes(c)).slice(0, Math.max(0, QUICK_CAT_VISIBLE - missingPriority.length));
    cats = all.filter(c => keep.includes(c) || missingPriority.includes(c));
  }
  const hasMore = all.length > cats.length;
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

// Business Surplus only: the sidebar shows the priority-ordered categories first (real B2B surplus
// streams) and tucks the specialized/waste-stream tail behind a "More categories" toggle, so the
// same list/chip design just renders fewer of them until expanded. Consumer/requests sidebars are
// unaffected — activeCategoryList() for those sections is short enough to show in full already.
// Same chip markup, typography, icons, spacing, active-state styling and click->filter logic either
// way; this only changes which/how many chips are present in the DOM.
function visibleCategoriesFor(list) {
  if (state.section !== 'business_waste') return { visible: list, hiddenCount: 0 };
  const n = state.businessCategoriesPrimaryCount || list.length;
  // If the currently-active filter is one of the "hidden" tail categories, keep the list expanded
  // so its chip is still visible/selectable rather than disappearing on the user.
  const activeIndex = list.indexOf(state.category);
  if (state.showAllBusinessCategories || (activeIndex >= 0 && activeIndex >= n)) {
    return { visible: list, hiddenCount: 0 };
  }
  return { visible: list.slice(0, n), hiddenCount: Math.max(0, list.length - n) };
}

function renderCategories() {
  const wrap = $('#categories');
  const { visible, hiddenCount } = visibleCategoriesFor(activeCategoryList());
  wrap.innerHTML = `<span class="chip ${state.category === '' ? 'active' : ''}" data-c=""><span class="cat-icon"><i data-lucide="layout-grid"></i></span>All</span>` +
    visible.map(c => {
      const isActive = state.category === c;
      // Active keeps the existing green highlight (handled by the .active CSS rule) rather than
      // the category's own color — an inline style would otherwise win over that class rule.
      const colorStyle = !isActive && CATEGORY_COLORS[c] ? ` style="color:${CATEGORY_COLORS[c]}"` : '';
      return `<span class="chip ${isActive ? 'active' : ''}${PRIORITY_CATEGORIES.includes(c) ? ' chip-priority' : ''}" data-c="${escapeHtml(c)}"><span class="cat-icon"${colorStyle}><i data-lucide="${CATEGORY_ICONS[c] || 'package'}"></i></span>${escapeHtml(c)}</span>`;
    }).join('') +
    (hiddenCount > 0 ? `<span class="chip chip-more" id="moreCategoriesBtn"><span class="cat-icon"><i data-lucide="more-horizontal"></i></span>More categories</span>` : '');
  wrap.querySelectorAll('.chip[data-c]').forEach(el => el.onclick = () => {
    state.category = el.dataset.c;
    renderCategories();
    state.section === 'requests' ? loadRequests() : loadItems();
  });
  const moreBtn = $('#moreCategoriesBtn');
  if (moreBtn) moreBtn.onclick = () => { state.showAllBusinessCategories = true; renderCategories(); };
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

// ---------- Impact Tracker collapsed tab + slide-out panel ----------
// Content/data inside (#ecoPanel, populated by loadEcoPanel()) is completely unchanged — this only
// wires the open/close chrome around it: click the edge tab to slide the panel in, close via the
// close button, the overlay, or Escape. Never pushes/resizes the homepage grid — the panel and its
// overlay are both position:fixed, entirely outside normal document flow.
function bindImpactPanel() {
  const tabBtn = $('#impactTabBtn');
  const panel = $('#impactPanel');
  const overlay = $('#impactPanelOverlay');
  const closeBtn = $('#impactPanelCloseBtn');
  if (!tabBtn || !panel || !overlay || !closeBtn) return;

  const openPanel = () => {
    panel.classList.add('open');
    overlay.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    tabBtn.setAttribute('aria-expanded', 'true');
  };
  const closePanel = () => {
    panel.classList.remove('open');
    overlay.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
    tabBtn.setAttribute('aria-expanded', 'false');
  };
  tabBtn.onclick = () => (panel.classList.contains('open') ? closePanel() : openPanel());
  closeBtn.onclick = closePanel;
  overlay.onclick = closePanel;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panel.classList.contains('open')) closePanel(); });
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
// labelIcon = the small top-left "TOP FOOD GIVER" style pill icon; statIcon = the icon next to the
// confirmed-donations count; emoji = large decorative art on the card (a stand-in for a custom
// illustration — see loadMonthlyBadges()'s caller for why); footerMsg = the always-visible bottom
// bar message (distinct from emptyMsg, which only shows while there's no champion yet).
const CHAMPION_KINDS = [
  { key: 'food_giver', theme: 'gold', labelIcon: 'crown', statIcon: 'soup', emoji: '🍱', title: 'Top Food Giver', emptyMsg: 'Be the first to rescue surplus food this month.', footerMsg: 'Help reduce food waste and feed people in need.' },
  { key: 'reuse_donor', theme: 'silver', labelIcon: 'recycle', statIcon: 'package', emoji: '📦', title: 'Top Reuse Donor', emptyMsg: 'Be the first to give an item a second life this month.', footerMsg: 'Give items a new home. Reduce waste. Support your community.' },
  { key: 'community_champion', theme: 'bronze', labelIcon: 'sprout', statIcon: 'users', emoji: '🌍', title: 'Community Champion', emptyMsg: 'Start making an impact today and inspire others.', footerMsg: 'Small actions. Bigger impact. Build a greener community together.' }
];

function championBoxHtml(kind, entry) {
  const count = entry ? entry.count : 0;
  return `<div class="champion-box theme-${kind.theme}">
    <div class="champion-topline">
      <span class="champion-label-pill"><i data-lucide="${kind.labelIcon}" class="champion-label-icon"></i>${kind.title.toUpperCase()}</span>
      <span class="champion-rank"><i data-lucide="award" class="champion-rank-icon"></i></span>
    </div>
    <div class="champion-main">
      <div class="champion-text">
        <div class="champion-name">${entry ? escapeHtml(entry.name) + (entry.account_type === 'business' ? ' <span class="owner-badge">Business</span>' : '') : 'No champion yet'}</div>
        <div class="champion-sub">${entry ? `${entry.count} completed this month` : kind.emptyMsg}</div>
        <div class="champion-stat">
          <span class="champion-stat-icon"><i data-lucide="${kind.statIcon}"></i></span>
          <div><strong>${count}</strong><small>confirmed donation${count === 1 ? '' : 's'}</small></div>
        </div>
      </div>
      <div class="champion-illustration" aria-hidden="true">${kind.emoji}</div>
    </div>
    <div class="champion-footer"><i data-lucide="leaf" style="width:12px;height:12px"></i> ${escapeHtml(kind.footerMsg)}</div>
  </div>`;
}

function championsSectionHtml(badges) {
  return `
    <div class="champions-top">
      <div class="champions-head-row">
        <span class="champions-head-deco">
          <span class="champions-sparkle s1">✦</span>
          <i data-lucide="trophy" class="section-icon"></i>
          <span class="champions-sparkle s2">✦</span>
        </span>
        <div>
          <div class="champions-head">Monthly Community Champions</div>
          <div class="champions-sub">Recognizing the people making the biggest impact this month.</div>
        </div>
      </div>
      <div class="champions-month"><i data-lucide="calendar" style="width:13px;height:13px"></i> ${escapeHtml(badges.month)}</div>
    </div>
    <div class="champions-grid">
      ${CHAMPION_KINDS.map(k => championBoxHtml(k, badges[k.key])).join('')}
    </div>
    <div class="champions-view-all-wrap">
      <span class="champions-sparkle s3">✦</span>
      <button type="button" class="champions-view-all" id="viewAllContributorsBtn"><i data-lucide="users" style="width:15px;height:15px"></i> View all contributors →</button>
      <span class="champions-sparkle s4">✦</span>
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

// PHASE 7: minimum coherent pagination UI over the Phase 6 opt-in backend pagination. Sending
// page/limit turns the response into { items, page, limit, total, hasMore } (see server.js) instead
// of the old bare array — both loadItems() and loadRequests() now always send them, so the grid
// always has an accurate hasMore/total, and a "Load more" button (not infinite scroll, per the
// Phase 7 rules) appends subsequent pages. A fresh call (append=false, the default — every existing
// filter-change call site is unchanged and automatically gets this) resets to page 1 and replaces
// the grid; append=true (only from the new "Load more" button) fetches the next page and concatenates.
const GRID_PAGE_SIZE = 20;

async function loadItems(append = false) {
  if (!append) state.itemsPage = 1;
  const params = new URLSearchParams();
  params.set('listing_type', state.section);
  if (state.category) params.set('category', state.category);
  if (state.priceType) params.set('price_type', state.priceType);
  if (state.q) params.set('q', state.q);
  if (state.location) params.set('location', state.location);
  if (state.urgentOnly) params.set('urgent', '1');
  if (state.sort) params.set('sort', state.sort);
  params.set('page', state.itemsPage);
  params.set('limit', GRID_PAGE_SIZE);
  const data = await api('/api/items?' + params.toString());
  state.items = append ? state.items.concat(data.items) : data.items;
  state.itemsHasMore = !!data.hasMore;
  renderGrid();
}

function loadMoreItems() { state.itemsPage = (state.itemsPage || 1) + 1; return loadItems(true); }

async function loadRequests(append = false) {
  if (!append) state.requestsPage = 1;
  const params = new URLSearchParams();
  params.set('request_type', state.requestType);
  if (state.category) params.set('category', state.category);
  if (state.q) params.set('q', state.q);
  if (state.urgentOnly) params.set('urgent', '1');
  if (state.location) params.set('location', state.location);
  if (state.sort) params.set('sort', state.sort);
  params.set('page', state.requestsPage);
  params.set('limit', GRID_PAGE_SIZE);
  const data = await api('/api/requests?' + params.toString());
  state.requests = append ? state.requests.concat(data.requests) : data.requests;
  state.requestsHasMore = !!data.hasMore;
  renderGrid();
}

function loadMoreRequests() { state.requestsPage = (state.requestsPage || 1) + 1; return loadRequests(true); }

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
    el.innerHTML = title + `<div class="grid">${state.requests.map(requestCardHtml).join('')}</div>` + loadMoreHtml(state.requestsHasMore, 'requests');
    el.querySelectorAll('.card').forEach(c => c.onclick = () => openRequestDetail(c.dataset.id));
    bindLoadMoreButton(el, 'requests');
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
  el.innerHTML = title + `<div class="grid">${state.items.map(cardHtml).join('')}</div>` + loadMoreHtml(state.itemsHasMore, 'items');
  el.querySelectorAll('.card').forEach(c => c.onclick = () => openDetail(c.dataset.id));
  bindWishlistButtons(el);
  bindLoadMoreButton(el, 'items');
}

// PHASE 7: minimum coherent pagination UI (Section 18) — a single "Load more" button, never
// infinite scroll. Rendered only when the backend's hasMore flag says another page exists; hidden
// entirely otherwise so pages with fewer than GRID_PAGE_SIZE results are unaffected. Kind ('items'
// or 'requests') picks which loadMore*/state.*HasMore pair to wire up.
function loadMoreHtml(hasMore, kind) {
  if (!hasMore) return '';
  return `<div class="load-more-wrap"><button class="secondary-btn" id="loadMore_${kind}">Load more</button></div>`;
}

function bindLoadMoreButton(el, kind) {
  const btn = el.querySelector(`#loadMore_${kind}`);
  if (!btn) return;
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = 'Loading…';
    try {
      if (kind === 'items') await loadMoreItems(); else await loadMoreRequests();
    } finally {
      // renderGrid() re-renders the whole grid (including a fresh Load more button, or none if this
      // was the last page), so there is nothing left to re-enable on this specific button instance.
    }
  };
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
const SHARE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" style="vertical-align:-3px"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="10.6" x2="15.4" y2="6.4"/><line x1="8.6" y1="13.4" x2="15.4" y2="17.6"/></svg>`;
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
  // Urgent always wins visually (red) regardless of budget type — same priority order as the item
  // card's urgent-food-badge taking precedence over its price-badge color.
  const typeCls = r.status === 'fulfilled' ? 'claimed' : (r.budget_type === 'paid' ? 'paid' : r.budget_type === 'exchange' ? 'exchange' : 'free');
  const badgeCls = r.is_urgent ? 'price-badge urgent' : `price-badge ${typeCls}`;
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
  if (!first) {
    // AUDIT FIX: an item with a photo still awaiting moderation (item.pending_media_count > 0,
    // no approved media yet) previously rendered identically to a listing with no photo at all —
    // the owner only ever learned about the pending review from a one-time alert() at the moment
    // they posted; revisiting My Posts/any card later gave no way to tell "still under review"
    // apart from "upload silently failed". This is a distinct, clearly-labeled state instead —
    // same box/sizing as the existing no-photo state, just a different icon + short label.
    if (item.pending_media_count > 0) {
      return `<span class="thumb-pending"><span class="thumb-emoji">🕒</span><span class="thumb-pending-label">Image under review</span></span>`;
    }
    return `<span class="thumb-emoji">📦</span>`;
  }
  if (first.media_type === 'video') return `<video src="${first.url}" muted></video>`;
  // thumb_url is a smaller, consistently 4:3-cropped/compressed variant generated server-side at
  // publish time (see processApprovedImage() in server.js) — used as the card's primary image so a
  // huge phone-camera original isn't shipped just to render a ~220px card. Falls back to the full
  // `url` for any image published before this pipeline existed (thumb_url is NULL on those rows),
  // so nothing breaks for pre-existing listings. srcset lets a high-DPI/larger card fall back up to
  // the full-resolution version instead of upscaling the thumb.
  const src = first.thumb_url || first.url;
  const srcset = first.thumb_url ? `${first.thumb_url} 640w, ${first.url} 1920w` : '';
  return `<img src="${src}"${srcset ? ` srcset="${srcset}" sizes="(max-width:640px) 45vw, 260px"` : ''} loading="lazy">`;
}

function itemPriceLabel(item) {
  if (item.status === 'claimed') return 'Claimed';
  // A "Paid" listing priced at ₹0 reads as a mistake/test artifact to a visitor ("₹0" next to a
  // green Free badge looks like a bug), not a deliberate price — treat it the same as Free rather
  // than printing a literal zero rupee amount.
  if (item.price_type === 'paid' && (!item.price || Number(item.price) <= 0)) return 'Free';
  if (item.price_type === 'paid') return '₹' + item.price;
  if (item.price_type === 'rent') return `₹${item.rent_rate}/${item.rent_period || 'day'}`;
  if (item.price_type === 'exchange') return 'Exchange';
  return 'Free';
}

// Color-coding for the card thumbnail's price badge, so Free/Paid/Rent/Exchange are distinguishable
// at a glance while scrolling a grid — mirrors the palette already used on the item detail page's
// .badge.free/.paid/.rent/.exchange classes (see styles.css), just as a solid pill instead of a
// light-background chip (the badge sits on top of a photo here, so it needs more contrast).
function itemPriceBadgeClass(item) {
  if (item.status === 'claimed') return 'claimed';
  if (item.price_type === 'paid' && (!item.price || Number(item.price) <= 0)) return 'free';
  return ['paid', 'rent', 'exchange'].includes(item.price_type) ? item.price_type : 'free';
}

function pickupFlagHtml(item) {
  if (!item.pickup_available) return '';
  return `<span class="pickup-flag">${PACKAGE_SVG}Pickup</span>`;
}

function galleryHtml(item) {
  const media = (item.media && item.media.length) ? item.media : (item.media_url ? [{ url: item.media_url, media_type: item.media_type }] : []);
  if (!media.length) {
    // AUDIT FIX: same gap as thumbInnerHtml() above — the detail view showed nothing at all for a
    // listing whose photo is still pending review, indistinguishable from a listing that never had
    // a photo. Small, existing-style-consistent note instead of silence.
    if (item.pending_media_count > 0) {
      return `<div class="gallery-pending">🕒 ${item.pending_media_count} photo${item.pending_media_count > 1 ? 's' : ''} under review — will appear here once approved</div>`;
    }
    return '';
  }
  return `<div class="gallery">${media.map(m => m.media_type === 'video'
    ? `<video src="${m.url}" controls></video>`
    : `<img src="${m.url}">`).join('')}</div>`;
}

// REDESIGN (listing detail page presentation overhaul — see openDetail()): large hero image +
// below-hero thumbnail strip for multi-photo listings, replacing the old equal-size horizontal
// scroll strip. Kept as a separate function from galleryHtml() above (still used nowhere else,
// left in place) rather than editing it in place, so nothing outside openDetail() is affected.
function detailGalleryHtml(item) {
  const media = (item.media && item.media.length) ? item.media : (item.media_url ? [{ url: item.media_url, media_type: item.media_type, thumb_url: item.thumb_url }] : []);
  if (!media.length) {
    if (item.pending_media_count > 0) {
      return `<div class="detail-gallery-hero detail-gallery-empty"><span class="thumb-emoji">🕒</span><p>${item.pending_media_count} photo${item.pending_media_count > 1 ? 's' : ''} under review — will appear here once approved</p></div>`;
    }
    // "Listing without an image" test case — a clear, on-brand placeholder instead of empty space.
    return `<div class="detail-gallery-hero detail-gallery-empty"><span class="thumb-emoji">📦</span><p>No photo added for this listing</p></div>`;
  }
  const first = media[0];
  const heroInner = first.media_type === 'video' ? `<video src="${first.url}" controls></video>` : `<img src="${first.url}" id="detailHeroImg">`;
  const thumbs = media.length > 1 ? `<div class="detail-gallery-thumbs">${media.map((m, i) => `
    <button type="button" class="detail-gallery-thumb${i === 0 ? ' active' : ''}" data-i="${i}">${m.media_type === 'video' ? `<video src="${m.url}" muted></video>` : `<img src="${m.thumb_url || m.url}">`}</button>`).join('')}</div>` : '';
  return `<div class="detail-gallery"><div class="detail-gallery-hero" id="detailGalleryHero">${heroInner}</div>${thumbs}</div>`;
}

// Clear availability state, surfaced up front rather than only implied by whether a claim form
// happens to render below — explicitly requested for the "expired/closed listing" case.
function detailAvailabilityHtml(item) {
  if (item.status === 'claimed') return `<span class="detail-availability claimed"><i data-lucide="handshake" style="width:13px;height:13px"></i>Claimed</span>`;
  if (item.status !== 'available') return `<span class="detail-availability closed"><i data-lucide="x-circle" style="width:13px;height:13px"></i>No longer available</span>`;
  return `<span class="detail-availability available"><i data-lucide="check-circle" style="width:13px;height:13px"></i>Available</span>`;
}

const CONDITION_LABELS = { new: 'New', like_new: 'Like new', used: 'Used', needs_repair: 'Needs repair' };
function conditionLabel(c) { return CONDITION_LABELS[c] || titleCase((c || '').replace(/_/g, ' ')); }

// Food Rescue listings (same FOOD_CATEGORIES_FRONT check already used by the post form to decide
// whether to show food-specific fields) get a dedicated highlight panel on the detail page: urgent
// state, quantity/servings exactly as the poster entered it, area, and a live-computed countdown
// (foodRescueCountdownLabel — same helper already used on the homepage Food Rescue hero cards).
// Nothing here is fabricated — every value only renders if the listing actually has it.
function foodRescueDetailHtml(item) {
  const countdown = item.available_until ? foodRescueCountdownLabel(item.available_until) : '';
  const area = item.pickup_area || item.owner_location || '';
  return `<div class="detail-food-panel">
    <div class="detail-food-panel-head"><span aria-hidden="true">🍱</span>Food Rescue listing${item.is_urgent ? '<span class="detail-food-urgent">URGENT</span>' : ''}</div>
    <div class="detail-food-meta">
      ${item.quantity ? `<span><i data-lucide="users" style="width:13px;height:13px"></i>${escapeHtml(item.quantity)}</span>` : ''}
      ${area ? `<span><i data-lucide="map-pin" style="width:13px;height:13px"></i>${escapeHtml(area)}</span>` : ''}
      ${countdown ? `<span><i data-lucide="clock" style="width:13px;height:13px"></i>${escapeHtml(countdown)}</span>` : ''}
    </div>
  </div>`;
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
      <span class="price-badge ${itemPriceBadgeClass(item)}">${itemPriceLabel(item)}</span>
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
      // Pre-existing bug fixed here: item ids are nanoid strings (e.g. "TcIyO6Bhf-VGabK48Zpdp"),
      // not numbers. `Number(...)` silently turned every id into NaN, so state.wishlist never
      // actually matched item.id on the "liked" check in cardHtml() -- the heart never reliably
      // showed as already-saved. Keeping the id as the real string fixes that and is required for
      // Saved Items to work at all.
      const id = btn.dataset.wish;
      if (state.wishlist.has(id)) state.wishlist.delete(id); else state.wishlist.add(id);
      saveWishlistToStorage();
      btn.classList.toggle('active');
    };
  });
}

function escapeHtml(s) { return (s || '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

// Display-only formatting (never mutates the stored name/location) — used for the profile dropdown
// header, e.g. "surya" -> "Surya", "chennai" -> "Chennai".
function titleCase(s) { return (s || '').replace(/\b\w/g, c => c.toUpperCase()); }

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

// ---------- change password (while logged in) ----------
// Distinct from the forgot/reset-by-email-token flow above — this is Password & Security in the
// profile dropdown, for a user who already knows their current password and just wants to change
// it. Reuses the same pw-toggle/strength-meter UI as every other password field in the app.
function openChangePasswordModal() {
  showModal(`
    <h2>Password &amp; Security</h2>
    <form id="changePwForm" novalidate>
      <label for="cpCurrent">Current password</label>
      <div class="pw-field">
        <input id="cpCurrent" name="currentPassword" type="password" required minlength="6" maxlength="72" autocomplete="current-password">
        ${pwToggleHtml('cpCurrent')}
      </div>
      <label for="cpNew">New password</label>
      <div class="pw-field">
        <input id="cpNew" name="newPassword" type="password" required minlength="6" maxlength="72" autocomplete="new-password">
        ${pwToggleHtml('cpNew')}
      </div>
      ${strengthMeterHtml('cpNew')}
      <label for="cpConfirm">Confirm new password</label>
      <div class="pw-field">
        <input id="cpConfirm" name="confirmPassword" type="password" required minlength="6" maxlength="72" autocomplete="new-password">
        ${pwToggleHtml('cpConfirm')}
      </div>
      <div class="error" id="cpError" role="alert" aria-live="polite"></div>
      <div class="success-text" id="cpSuccess" role="status" aria-live="polite" style="display:none"></div>
      <button class="primary-btn" type="submit" id="cpSubmit">Change password</button>
    </form>
  `);
  document.querySelectorAll('.pw-toggle').forEach(wirePasswordToggle);
  wireStrengthMeter($('#cpNew'), 'cpNew');
  if (window.lucide) lucide.createIcons();

  $('#changePwForm').onsubmit = async (e) => {
    e.preventDefault();
    const errEl = $('#cpError'), okEl = $('#cpSuccess');
    errEl.textContent = ''; okEl.style.display = 'none';
    const currentPassword = $('#cpCurrent').value;
    const newPassword = $('#cpNew').value;
    const confirmPassword = $('#cpConfirm').value;
    if (newPassword !== confirmPassword) { errEl.textContent = 'New passwords do not match.'; return; }
    if (newPassword.length < 6) { errEl.textContent = 'Password must be at least 6 characters.'; return; }

    const btn = $('#cpSubmit');
    try {
      await submitAuthForm(btn, 'Changing…', async () => {
        await api('/api/change-password', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPassword, newPassword, confirmPassword })
        });
        okEl.textContent = 'Password changed. Your other devices have been signed out.';
        okEl.style.display = 'block';
        $('#changePwForm').querySelectorAll('input').forEach(i => i.value = '');
        btn.textContent = 'Done';
      });
    } catch (err) {
      errEl.textContent = authErrorMessage(err);
    }
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

// options.foodRescue: set when opened from the dedicated "Give away surplus food" action-sheet
// option (see #sheetPostFoodBtn) instead of the generic "Give / Exchange an item" one. Still the
// exact same form/endpoint underneath — this only pre-selects the Food (Surplus) category so the
// donor lands straight on the pickup-deadline/urgent fields instead of having to find "Food" among
// ~15 categories themselves, and swaps the heading/placeholder copy to match what they came here
// to do.
function openPostModal(options) {
  const foodRescue = !!(options && options.foodRescue);
  const isBusiness = state.section === 'business_waste';
  showModal(`
    <h2>${foodRescue ? '🍱 Give away surplus food' : isBusiness ? 'Post business surplus' : 'Post an item'}</h2>
    <p class="modal-subtitle">${foodRescue ? 'From a restaurant, event, or wedding — help it find people before it goes to waste.' : 'Share items you no longer need. Help someone. Help the planet. 🌱'}</p>
    <form id="postForm" class="post-item-form">

      <div class="form-section">
        <div class="form-section-head"><span class="form-section-num">1</span>Basic Details</div>

        <label>Title <span class="req">*</span></label>
        <input name="title" required maxlength="120" id="postTitle" placeholder="${foodRescue ? 'e.g. Wedding Biryani (Veg), serves 40' : isBusiness ? 'e.g. 20 office chairs, CNC metal scrap' : 'e.g. Old iPhone 8, working condition'}">

        <label>Photos <span class="hint-inline">Optional · Up to 5 photos</span></label>
        <div class="photo-dropzone" id="photoDropzone" tabindex="0" role="button" aria-label="Upload photos">
          <span class="photo-dropzone-icon">📷</span>
          <span class="photo-dropzone-text"><strong>Upload photos</strong><br>or drag and drop</span>
          <input type="file" name="media" id="mediaInput" accept="image/*,video/*" multiple class="photo-input-hidden">
        </div>
        <div class="photo-thumbs" id="photoThumbs"></div>
        <p class="hint">Good photos = more chances to find the right person.</p>

        <label>Description <span class="req">*</span></label>
        <textarea name="description" required maxlength="1500" placeholder="${foodRescue ? 'What is it, roughly how much, any dietary notes (veg/non-veg)...' : 'Describe condition, pickup details, reason for giving, etc.'}"></textarea>
      </div>

      <div class="form-section">
        <div class="form-section-head"><span class="form-section-num">2</span>Item Details</div>

        <label>Category <span class="req">*</span></label>
        <select name="category" id="postCategory" required>${activeCategoryList().map(c => `<option value="${escapeHtml(c)}" ${foodRescue && c === 'Food (Surplus)' ? 'selected' : ''}>${escapeHtml(c)}</option>`).join('')}</select>

        <div class="row2">
          <div><label>Condition <span class="req">*</span></label>
            <select name="condition"><option value="new">New</option><option value="like_new">Like new</option><option value="used" selected>Used</option><option value="needs_repair">Needs repair</option></select>
          </div>
          <div><label>Quantity</label><input name="quantity" placeholder="${foodRescue ? 'e.g. serves 40, 2 trays' : 'e.g. 50 kg, 200 L, 2 pieces'}"></div>
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
        <label><input type="checkbox" id="foodUrgent" ${foodRescue ? 'checked' : ''} style="width:auto;display:inline-block;margin-right:6px">🔥 Urgent — pickup needed soon</label>
        <p class="hint food-safety-hint">Food safety: Please share accurate information about the food and its condition. Zineedo does not inspect or certify food safety. Recipients should use their own judgment before consuming.</p>
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
        showToast(`Posted! ${posted.pending_media_count} photo${posted.pending_media_count > 1 ? 's are' : ' is'} still being reviewed and will appear once approved.`, 'info');
      } else {
        showToast('Your item was posted successfully!', 'success');
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
// Status panel shown instead of the claim form when the current user already has a pending/accepted
// claim on this exact item — "make the resulting claim/request status visible" without inventing a
// new status system: it just surfaces what /api/my/claims-sent (already used by the Activity page)
// already knows, right where the user is about to act again.
function claimStatusPanelHtml(claim, isFoodRescue) {
  const verb = isFoodRescue ? 'offer to help' : 'request';
  if (claim.status === 'accepted') {
    return `<div class="claim-status-panel accepted">
      <strong>✓ Your ${verb} was accepted!</strong>
      <p>Coordinate pickup with the owner from your Activity page.</p>
      <button type="button" class="ghost" id="claimStatusViewActivity">View in Activity →</button>
    </div>`;
  }
  return `<div class="claim-status-panel pending">
    <strong>⏳ You already sent a ${verb} for this listing</strong>
    <p>Waiting for the owner to respond — you'll be notified when they do.</p>
    <button type="button" class="ghost" id="claimStatusViewActivity">View in Activity →</button>
  </div>`;
}

// Confirmation step between "Request this item" / "I can help" and the actual API call — shows
// exactly what's being requested (thumbnail, title, price/urgent state, the typed message) so
// nothing is submitted by accident, then performs the real POST /api/items/:id/claim call (same
// endpoint/payload the old direct-submit used) with its own disabled/loading state so a double
// click can't fire two requests, and surfaces any server error (stale "no longer available",
// network failure, etc.) inline instead of a dead end.
function openClaimConfirmModal(item, message, isFoodRescue) {
  const actionLabel = isFoodRescue ? 'I can help' : item.price_type === 'paid' ? 'Request to buy' : item.price_type === 'exchange' ? 'Propose exchange' : item.price_type === 'rent' ? 'Request to rent' : 'Request this item';
  showModal(`
    <h2>${isFoodRescue ? '🍱 Confirm — I can help' : 'Confirm your request'}</h2>
    <div class="claim-confirm-item">
      <div class="claim-confirm-thumb">${thumbInnerHtml(item)}</div>
      <div class="claim-confirm-info">
        <strong>${escapeHtml(item.title)}</strong>
        <div class="hint">${itemPriceLabel(item)}${item.is_urgent ? ' · 🔥 Urgent' : ''}</div>
      </div>
    </div>
    ${isFoodRescue && item.is_urgent ? `<div class="emergency-note" style="background:#FFF4EF;border-color:#FBD9C6;color:#A23B12">🔥 This is marked urgent — please only confirm if you can collect it in time.</div>` : ''}
    <div class="hint" style="margin-top:10px">${message ? `Your message: "${escapeHtml(message)}"` : 'No message added.'}</div>
    <div class="error" id="claimConfirmError"></div>
    <div class="post-form-actions" style="margin-top:16px">
      <button type="button" class="ghost" id="claimConfirmBack">← Back</button>
      <button type="button" class="primary-btn" id="claimConfirmSubmit">${actionLabel}</button>
    </div>
  `, 'detail-modal');
  $('#claimConfirmBack').onclick = () => openDetail(item.id, message);
  const submitBtn = $('#claimConfirmSubmit');
  submitBtn.onclick = async () => {
    // Guards accidental double-submit (double-click, double-tap) — once disabled, repeat clicks
    // while the first request is still in flight are simply ignored rather than firing again.
    if (submitBtn.disabled) return;
    submitBtn.disabled = true;
    const original = submitBtn.textContent;
    submitBtn.textContent = 'Sending…';
    try {
      await api(`/api/items/${item.id}/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) });
      closeModal();
      showToast(isFoodRescue ? 'Your offer to help was sent!' : 'Request sent to the owner!', 'success');
      loadTrending();
    } catch (err) {
      // Covers both a real server rejection (e.g. the item moved to claimed/closed in the time this
      // modal was open — the exact same "This item is no longer available" message the API already
      // returns) and a network failure (api() throws there too) — either way, the message typed in
      // survives (still held in this closure) and the button re-enables so the user can retry.
      $('#claimConfirmError').textContent = err.message || 'Something went wrong. Please check your connection and try again.';
      submitBtn.disabled = false;
      submitBtn.textContent = original;
    }
  };
}

async function openDetail(id, prefillMessage) {
  const item = await api('/api/items/' + id);
  const isOwner = state.user && state.user.id === item.user_id;
  const isFoodRescue = FOOD_CATEGORIES_FRONT.includes(item.category);
  const unavailable = item.status !== 'available';
  const liked = state.wishlist.has(item.id);
  // Claim-flow improvement: a non-owner who already has a pending/accepted claim on THIS item gets
  // a status panel instead of another claim form — reuses the existing /api/my/claims-sent endpoint
  // (no new API, no schema change) purely as a read to decide what to render. A previously *declined*
  // claim does not block a new attempt (the backend itself never blocked this — item.status stays
  // 'available' after a decline — so this is a UI convenience, not a new restriction).
  let myClaim = null;
  if (!isOwner && state.user && !unavailable) {
    try {
      const claims = await api('/api/my/claims-sent');
      const mine = claims.filter(c => c.item_id === item.id);
      myClaim = mine.find(c => c.status === 'pending') || mine.find(c => c.status === 'accepted') || null;
    } catch { /* non-critical — if this read fails, just fall back to showing the normal form */ }
  }
  showModal(`
    ${detailGalleryHtml(item)}
    <div class="detail-status-row">
      <span class="detail-price-badge ${itemPriceBadgeClass(item)}">${itemPriceLabel(item)}</span>
      ${item.is_urgent ? `<span class="detail-urgent-badge">🔥 Urgent</span>` : ''}
      ${detailAvailabilityHtml(item)}
    </div>
    <div class="detail-title-row">
      <h2>${escapeHtml(item.title)}</h2>
      <div class="detail-title-actions">
        <button type="button" class="wishlist-btn detail-wishlist-btn${liked ? ' active' : ''}" data-wish="${item.id}" aria-label="Save to wishlist">${HEART_SVG}</button>
        <button type="button" id="shareItemBtn" class="share-btn" aria-label="Share this listing">${SHARE_SVG} Share</button>
      </div>
    </div>
    <div class="detail-meta-row">
      <span>${escapeHtml(displayCategory(item.category))}</span><span>·</span>
      <span>${escapeHtml(conditionLabel(item.condition))}</span><span>·</span>
      <span>${escapeHtml(timeAgo(item.created_at))}</span>
      ${item.quantity ? `<span>·</span><span>Qty: ${escapeHtml(item.quantity)}</span>` : ''}
    </div>
    ${item.pickup_available || (item.food_pref && FOOD_PREF_LABELS[item.food_pref]) || item.is_recurring ? `<div class="detail-status-row" style="margin-top:8px">
      ${item.pickup_available ? `<span class="pickup-badge">🚚 Pickup available</span>` : ''}
      ${item.food_pref && FOOD_PREF_LABELS[item.food_pref] ? `<span class="badge food-pref">${FOOD_PREF_LABELS[item.food_pref]}</span>` : ''}
      ${item.is_recurring ? `<span class="badge recurring">${escapeHtml(item.frequency || 'recurring')}</span>` : ''}
    </div>` : ''}
    ${item.price_type === 'exchange' && item.exchange_for ? `<div class="hint">Wants in exchange: ${escapeHtml(item.exchange_for)}</div>` : ''}
    ${item.price_type === 'rent' ? `<div class="hint">Rent: ₹${item.rent_rate}/${escapeHtml(item.rent_period || 'day')}${item.deposit ? ` · Suggested deposit: ₹${item.deposit}` : ''}</div>` : ''}
    ${isFoodRescue ? foodRescueDetailHtml(item) : ''}
    ${item.available_until ? `<div class="hint food-until-hint">🕐 Available until ${escapeHtml(formatAvailableUntil(item.available_until))} <span class="hint">(donor's stated pickup deadline, not a certified food-safety date)</span></div>` : ''}
    <div class="detail-section">
      <h3 class="detail-section-title">Description</h3>
      <p class="detail-description">${escapeHtml(item.description)}</p>
    </div>
    <div class="detail-owner">
      Posted by <button type="button" class="owner-name-link" data-uid="${escapeHtml(item.user_id)}"><strong>${escapeHtml(item.owner_name)}</strong></button> ${item.owner_type === 'business' ? '<span class="owner-badge">Business</span>' : '<span class="owner-badge">Individual</span>'}
      ${item.owner_verified ? ' <span class="verified-badge">✓ Verified</span>' : ''}
      ${item.owner_location ? `<br>📍 ${escapeHtml(item.owner_location)}` : ''}
    </div>
    ${item.pickup_area && item.pickup_area !== item.owner_location ? `<div class="hint">📍 Pickup area: ${escapeHtml(item.pickup_area)}</div>` : ''}
    ${exactPickupHtml(item)}
    ${isOwner ? `
      <div class="detail-actions">
        <button class="primary-btn" id="editItemBtn">Edit</button>
        <button class="primary-btn" id="closeItemBtn" style="background:#c0392b">Mark as given away / closed</button>
      </div>
    ` : `
      ${unavailable ? `<div class="detail-unavailable-note">${item.status === 'claimed' ? '🤝 This item has already been claimed by someone else.' : '🚫 This item is no longer available.'}</div>`
        : myClaim ? claimStatusPanelHtml(myClaim, isFoodRescue) : `
        <form id="claimForm">
          <label>Message to owner (optional)</label>
          <textarea name="message" placeholder="e.g. I'd like to pick this up tomorrow">${escapeHtml(prefillMessage || '')}</textarea>
          <div class="error" id="claimError"></div>
          <button class="primary-btn" type="submit">${isFoodRescue ? 'I can help' : item.price_type === 'paid' ? 'Request to buy' : item.price_type === 'exchange' ? 'Propose exchange' : item.price_type === 'rent' ? 'Request to rent' : 'Request this item'}</button>
        </form>
      `}
      ${state.user ? `<p style="margin-top:10px"><a href="#" id="reportLink" style="color:#c0392b;font-size:12px">Report this post</a></p>` : ''}
    `}
  `, 'detail-modal');
  if (isOwner) {
    $('#editItemBtn').onclick = () => openEditModal(item);
    $('#closeItemBtn').onclick = async () => {
      await api('/api/items/' + item.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'closed' }) });
      closeModal(); loadItems();
    };
  } else {
    const claimForm = $('#claimForm');
    if (claimForm) {
      // Submitting the form no longer calls the API directly — it opens a confirmation step first
      // (openClaimConfirmModal) showing exactly what's being requested, with the actual API call
      // (and its loading/duplicate-submit/error handling) happening only once the user confirms.
      claimForm.onsubmit = (e) => {
        e.preventDefault();
        if (!state.user) { closeModal(); openAuthModal('login'); return; }
        const fd = Object.fromEntries(new FormData(e.target));
        openClaimConfirmModal(item, fd.message || '', isFoodRescue);
      };
    }
    const viewActivityBtn = $('#claimStatusViewActivity');
    if (viewActivityBtn) viewActivityBtn.onclick = () => { closeModal(); openActivity('tabItemsSent'); };
    const reportLink = $('#reportLink');
    if (reportLink) reportLink.onclick = (e) => { e.preventDefault(); openReportModal('item', item.id); };
  }
  // Wire the gallery hero + thumbnail strip up to the lightbox — real uploaded photos only (videos
  // get native controls instead, same as before, so they're excluded from the lightbox image set).
  const media = (item.media && item.media.length) ? item.media : (item.media_url ? [{ url: item.media_url, media_type: item.media_type }] : []);
  const galleryImages = media.filter(m => m.media_type !== 'video');
  function bindDetailHero(m) {
    const heroImg = $('#detailHeroImg');
    if (!heroImg) return;
    heroImg.style.cursor = 'zoom-in';
    heroImg.onclick = () => {
      const idx = galleryImages.findIndex(g => g.url === m.url);
      openLightbox(galleryImages, idx >= 0 ? idx : 0);
    };
  }
  if (media.length) bindDetailHero(media[0]);
  modalRoot.querySelectorAll('.detail-gallery-thumb').forEach(btn => {
    btn.onclick = () => {
      const i = +btn.dataset.i;
      const m = media[i];
      modalRoot.querySelectorAll('.detail-gallery-thumb').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      const heroEl = $('#detailGalleryHero');
      heroEl.innerHTML = m.media_type === 'video' ? `<video src="${m.url}" controls></video>` : `<img src="${m.url}" id="detailHeroImg">`;
      bindDetailHero(m);
    };
  });
  bindCopyButtons();
  bindShareButton(item);
  bindWishlistButtons(modalRoot);
  if (window.lucide) lucide.createIcons();
}

// Share this listing. navigator.share() gives the native OS share sheet (WhatsApp, etc.) on mobile
// browsers that support it; desktop/unsupported browsers fall back to copying the link, mirroring
// the existing .copy-btn "Copied!" feedback pattern elsewhere on this page.
function bindShareButton(item) {
  const btn = $('#shareItemBtn');
  if (!btn) return;
  const shareUrl = `${location.origin}/?item=${encodeURIComponent(item.id)}`;
  btn.onclick = async () => {
    const shareData = { title: item.title, text: `Check out "${item.title}" on Zineedo`, url: shareUrl };
    if (navigator.share) {
      try { await navigator.share(shareData); } catch { /* user cancelled the share sheet — not an error */ }
      return;
    }
    try {
      await navigator.clipboard.writeText(shareUrl);
      const orig = btn.innerHTML;
      btn.innerHTML = 'Link copied!';
      setTimeout(() => { btn.innerHTML = orig; }, 1500);
    } catch {
      // No clipboard API either (very old browser) — nothing more we can do silently.
    }
  };
}

// ---------- edit item modal ----------
function openEditModal(item) {
  // Photos: item.media is the approved list (attachMedia always populates it); pending_media_count
  // covers anything still awaiting moderation, which can't be previewed/removed as a normal photo
  // yet (no public URL exists for it) — shown as a plain status line instead, same wording used
  // elsewhere on the card/gallery for this exact state.
  const existingPhotos = item.media || [];
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
      <label>Photos <span class="hint-inline">Up to 5 total</span></label>
      <div class="photo-thumbs" id="editExistingThumbs">${existingPhotos.map(m => `
        <div class="photo-thumb" data-media-id="${m.id}">
          <img src="${escapeHtml(m.thumb_url || m.url)}" alt="">
          <button type="button" class="photo-thumb-remove" data-remove-media="${m.id}" aria-label="Remove photo">×</button>
        </div>`).join('')}</div>
      ${item.pending_media_count > 0 ? `<p class="hint">🕒 ${item.pending_media_count} photo${item.pending_media_count > 1 ? 's' : ''} still under review.</p>` : ''}
      <div class="photo-dropzone" id="editPhotoDropzone" tabindex="0" role="button" aria-label="Add photos">
        <span class="photo-dropzone-icon">📷</span>
        <span class="photo-dropzone-text"><strong>Add photos</strong><br>or drag and drop</span>
        <input type="file" name="media" id="editMediaInput" accept="image/*" multiple class="photo-input-hidden">
      </div>
      <div class="photo-thumbs" id="editNewThumbs"></div>
      <div class="error" id="editError"></div>
      <button class="primary-btn" type="submit">Save changes</button>
    </form>
  `);

  // Deletions are tracked client-side and only sent on submit — clicking × just hides the thumb and
  // marks it, so a stray click doesn't commit anything until "Save changes" is actually pressed.
  const deletedMediaIds = new Set();
  $('#editExistingThumbs').querySelectorAll('[data-remove-media]').forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.removeMedia;
      deletedMediaIds.add(id);
      btn.closest('.photo-thumb').remove();
    };
  });

  // New-photo dropzone — same pattern as the post-item form's #mediaInput/#photoThumbs (preview
  // only; the actual upload+moderation happens server-side on submit).
  const editMediaInput = $('#editMediaInput');
  const editDropzone = $('#editPhotoDropzone');
  const editNewThumbs = $('#editNewThumbs');
  function renderEditNewThumbs() {
    const files = Array.from(editMediaInput.files || []);
    editNewThumbs.innerHTML = '';
    files.forEach(file => {
      const thumb = document.createElement('div');
      thumb.className = 'photo-thumb';
      thumb.innerHTML = `<img src="${URL.createObjectURL(file)}" alt="">`;
      thumb.title = file.name;
      editNewThumbs.appendChild(thumb);
    });
  }
  editDropzone.onclick = () => editMediaInput.click();
  editDropzone.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); editMediaInput.click(); } };
  editMediaInput.onchange = renderEditNewThumbs;
  ['dragover', 'dragenter'].forEach(evt => editDropzone.addEventListener(evt, (e) => { e.preventDefault(); editDropzone.classList.add('dragover'); }));
  ['dragleave', 'dragend', 'drop'].forEach(evt => editDropzone.addEventListener(evt, (e) => { e.preventDefault(); editDropzone.classList.remove('dragover'); }));
  editDropzone.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      editMediaInput.files = e.dataTransfer.files;
      renderEditNewThumbs();
    }
  });

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
    const hasNewFiles = editMediaInput.files && editMediaInput.files.length > 0;
    const hasDeletions = deletedMediaIds.size > 0;
    try {
      let updated;
      if (hasNewFiles || hasDeletions) {
        // Photos changed — submit as multipart so the new files (if any) actually reach the server;
        // a plain JSON body can't carry File objects. The form's existing fields (title, category,
        // etc.) ride along unchanged inside the same FormData.
        const fd = new FormData(e.target);
        if (hasDeletions) fd.set('delete_media_ids', JSON.stringify([...deletedMediaIds]));
        updated = await api('/api/items/' + item.id, { method: 'PATCH', body: fd });
      } else {
        const fd = Object.fromEntries(new FormData(e.target));
        updated = await api('/api/items/' + item.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fd) });
      }
      closeModal();
      loadItems();
      openDetail(item.id);
      if (hasNewFiles && updated.pending_media_count > 0) {
        showToast(`Saved! ${updated.pending_media_count} new photo${updated.pending_media_count > 1 ? 's are' : ' is'} still being reviewed and will appear once approved.`, 'info');
      }
    } catch (err) { $('#editError').textContent = err.message; }
  };
}

// ---------- post request modal (reverse marketplace) ----------
function openPostRequestModal() {
  const isService = state.requestType === 'service';
  showModal(`
    <h2>Post what you need</h2>
    <div class="privacy-note">🔒 Your exact location and contact details stay private. Only your general area (from your profile) is shown publicly — nothing more is shared until you accept a helper.</div>
    <form id="postRequestForm">
      <input type="hidden" name="request_type" value="${state.requestType}">
      <label>Title</label><input name="title" required placeholder="${isService ? 'e.g. Need an electrician for a fan installation' : 'e.g. Need a study table for a week'}">
      <label>Description</label><textarea name="description" required placeholder="Describe what you need and when. Avoid including your exact address, phone number, or email here — those stay private automatically."></textarea>
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
      ${isService ? `<div class="emergency-note" id="emergencyNote" style="display:none">⚠️ Need immediate help? For emergencies or unsafe situations, contact local emergency or roadside assistance services rather than relying on a community response.</div>` : ''}
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
  if (isService) {
    const emergencyNote = $('#emergencyNote');
    $('#isUrgent').onchange = (e) => { emergencyNote.style.display = e.target.checked ? 'block' : 'none'; };
  }

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
      showToast('Your request was posted successfully!', 'success');
    } catch (err) {
      $('#postRequestError').textContent = err.message;
      submitBtn.disabled = false;
    }
  };
}

// ---------- request detail ----------
// Status panel shown instead of the respond form when the current user already has a pending/
// accepted offer on this exact request — same purpose and same read-only reuse of an existing
// endpoint (/api/my/request-offers-sent, already used by the Activity page) as claimStatusPanelHtml
// does for items. A previously declined offer does not block a new attempt, matching the backend
// (declining never changes the request's 'open' status).
function requestOfferStatusPanelHtml(offer) {
  if (offer.status === 'accepted') {
    return `<div class="claim-status-panel accepted">
      <strong>✓ Your offer was accepted!</strong>
      <p>Coordinate with the requester from your Activity page.</p>
      <button type="button" class="ghost" id="offerStatusViewActivity">View in Activity →</button>
    </div>`;
  }
  return `<div class="claim-status-panel pending">
    <strong>⏳ You already offered to help with this request</strong>
    <p>Waiting for the requester to respond — you'll be notified when they do.</p>
    <button type="button" class="ghost" id="offerStatusViewActivity">View in Activity →</button>
  </div>`;
}

// Confirmation step between "I can help" and the actual API call — mirrors openClaimConfirmModal()
// for items: shows exactly what's being offered (request title, budget/price context, message,
// price offered, pickup summary) before submitting, and the real POST /api/requests/:id/respond call
// (same endpoint/payload the old direct-submit used) gets its own disabled/loading state plus inline
// error handling instead of a dead-end alert().
function openOfferConfirmModal(request, fd) {
  showModal(`
    <h2>Confirm — I can help</h2>
    <div class="claim-confirm-item">
      <div class="claim-confirm-thumb">${request.request_type === 'service' ? '🔧' : '📦'}</div>
      <div class="claim-confirm-info">
        <strong>${escapeHtml(request.title)}</strong>
        <div class="hint">${requestPriceLabel(request)}</div>
      </div>
    </div>
    ${request.is_urgent && request.request_type === 'service' ? `<div class="emergency-note">⚠️ Need immediate help? For emergencies or unsafe situations, contact local emergency or roadside assistance services rather than relying on a community response.</div>` : ''}
    <div class="hint" style="margin-top:10px">${fd.message ? `Your message: "${escapeHtml(fd.message)}"` : 'No message added.'}</div>
    ${fd.offered_price ? `<div class="hint">Your price: ₹${escapeHtml(fd.offered_price)}</div>` : ''}
    ${fd.pickup_area ? `<div class="hint">📍 ${escapeHtml(fd.pickup_area)}</div>` : ''}
    <div class="error" id="offerConfirmError"></div>
    <div class="post-form-actions" style="margin-top:16px">
      <button type="button" class="ghost" id="offerConfirmBack">← Back</button>
      <button type="button" class="primary-btn" id="offerConfirmSubmit">I can help</button>
    </div>
  `);
  $('#offerConfirmBack').onclick = () => openRequestDetail(request.id, fd);
  const submitBtn = $('#offerConfirmSubmit');
  submitBtn.onclick = async () => {
    if (submitBtn.disabled) return;
    submitBtn.disabled = true;
    const original = submitBtn.textContent;
    submitBtn.textContent = 'Sending…';
    try {
      await api(`/api/requests/${request.id}/respond`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fd) });
      closeModal();
      showToast('Your offer to help was sent!', 'success');
      loadRequests();
    } catch (err) {
      // Covers both a real rejection (the request moved to fulfilled/closed while this modal was
      // open — the exact "This request is no longer open" message the API already returns) and a
      // network failure — either way the typed fields survive (still held in fd) and the button
      // re-enables so the user can retry.
      $('#offerConfirmError').textContent = err.message || 'Something went wrong. Please check your connection and try again.';
      submitBtn.disabled = false;
      submitBtn.textContent = original;
    }
  };
}

async function openRequestDetail(id, prefill) {
  const r = await api('/api/requests/' + id);
  const isOwner = state.user && state.user.id === r.user_id;
  const unavailable = r.status !== 'open';
  // Same existing-offer check as the item claim flow (see openDetail()) — reuses the existing
  // /api/my/request-offers-sent endpoint purely as a read, no new API.
  let myOffer = null;
  if (!isOwner && state.user && !unavailable) {
    try {
      const offers = await api('/api/my/request-offers-sent');
      const mine = offers.filter(o => o.request_id === r.id);
      myOffer = mine.find(o => o.status === 'pending') || mine.find(o => o.status === 'accepted') || null;
    } catch { /* non-critical — fall back to showing the normal form */ }
  }
  showModal(`
    <h2>${escapeHtml(r.title)}</h2>
    ${requestBadgeHtml(r)} ${!isOwner ? (unavailable ? `<span class="detail-availability closed">No longer open</span>` : `<span class="detail-availability available">✓ Open</span>`) : ''}
    <p style="margin-top:12px">${escapeHtml(r.description)}</p>
    <div class="hint">Category: ${escapeHtml(displayCategory(r.category))} ${r.quantity ? '· Qty: ' + escapeHtml(r.quantity) : ''}</div>
    ${r.budget_type === 'exchange' && r.exchange_for ? `<div class="hint">Can exchange for: ${escapeHtml(r.exchange_for)}</div>` : ''}
    <div class="detail-owner">
      Posted by <button type="button" class="owner-name-link" data-uid="${escapeHtml(r.user_id)}"><strong>${escapeHtml(r.owner_name)}</strong></button> ${r.owner_type === 'business' ? '<span class="owner-badge">Business</span>' : '<span class="owner-badge">Individual</span>'}
      ${r.owner_verified ? ' <span class="verified-badge">✓ Verified</span>' : ''}
      ${r.owner_location ? `<br>📍 Approximate area: ${escapeHtml(r.owner_location)}` : ''}
    </div>
    ${r.is_urgent && r.request_type === 'service' ? `<div class="emergency-note">⚠️ Need immediate help? For emergencies or unsafe situations, contact local emergency or roadside assistance services rather than relying on a community response.</div>` : ''}
    ${isOwner ? `
      <div class="privacy-note">🔒 Your exact location and contact details stay private. They're only shared once you accept a helper below.</div>
      <button class="primary-btn" id="closeRequestBtn" style="background:#c0392b">Mark as fulfilled / closed</button>
    ` : unavailable ? `
      <div class="detail-unavailable-note">${r.status === 'fulfilled' ? '🤝 This request has already been fulfilled by someone else.' : '🚫 This request is no longer open.'}</div>
    ` : myOffer ? requestOfferStatusPanelHtml(myOffer) : `
      <form id="respondForm">
        <label>How can you help? (optional)</label>
        <textarea name="message" placeholder="e.g. I have one available, can drop it off tomorrow">${escapeHtml((prefill && prefill.message) || '')}</textarea>
        ${r.budget_type === 'paid' ? `<label>Your price (₹, optional)</label><input name="offered_price" type="number" min="0" step="1" placeholder="Leave blank to accept their budget" value="${escapeHtml((prefill && prefill.offered_price) || '')}">` : ''}
        ${pickupFieldsHtml(prefill)}
        <div class="hint">🔒 Your message is sent to the requester. Contact details are only exchanged if they accept your offer.</div>
        <div class="safety-note">⚠️ Stay safe: never send money, OTPs, passwords, or banking details to another member. Avoid paying anyone in advance unless you've met and confirmed the work.</div>
        <div class="error" id="respondError"></div>
        <button class="primary-btn" type="submit">I can help</button>
      </form>
    `}
    ${!isOwner && state.user ? `<p style="margin-top:10px"><a href="#" id="reportRequestLink" style="color:#c0392b;font-size:12px">Report this post</a></p>` : ''}
  `);
  if (isOwner) {
    $('#closeRequestBtn').onclick = async () => {
      await api('/api/requests/' + r.id, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'closed' }) });
      closeModal(); loadRequests();
    };
  } else {
    const respondForm = $('#respondForm');
    if (respondForm) {
      // Submitting no longer calls the API directly — it opens a confirmation step first
      // (openOfferConfirmModal), exactly mirroring the item claim flow's two-step pattern.
      respondForm.onsubmit = (e) => {
        e.preventDefault();
        if (!state.user) { closeModal(); openAuthModal('login'); return; }
        const fd = Object.fromEntries(new FormData(e.target));
        openOfferConfirmModal(r, fd);
      };
    }
    const viewActivityBtn = $('#offerStatusViewActivity');
    if (viewActivityBtn) viewActivityBtn.onclick = () => { closeModal(); openActivity('tabOffersSent'); };
    const reportLink = $('#reportRequestLink');
    if (reportLink) reportLink.onclick = (e) => { e.preventDefault(); openReportModal('request', r.id); };
  }
}

// ---------- report modal ----------
const REPORT_LABELS = { user: 'this user', rating: 'this review', item: 'this post', request: 'this post' };
// Keep in sync with server.js REPORT_CATEGORIES — a fixed list rather than free text so reports
// mean something specific and can eventually be triaged by category.
const REPORT_CATEGORIES = [
  { key: 'scam_fraud', label: 'Scam / fraud' },
  { key: 'harassment', label: 'Harassment' },
  { key: 'suspicious_request', label: 'Suspicious request' },
  { key: 'inappropriate_content', label: 'Inappropriate content' },
  { key: 'fake_profile', label: 'Fake profile' },
  { key: 'asking_for_money', label: 'Asking for money' },
  { key: 'unsafe_behavior', label: 'Unsafe behavior' },
  { key: 'other', label: 'Other' }
];
function reportCategoryLabel(key) { return (REPORT_CATEGORIES.find(c => c.key === key) || {}).label || key; }

function openReportModal(targetType, targetId) {
  showModal(`
    <h2>Report ${REPORT_LABELS[targetType] || 'this post'}</h2>
    <form id="reportForm">
      <label>What's wrong?</label>
      <select name="category" required>
        <option value="">Select a reason</option>
        ${REPORT_CATEGORIES.map(c => `<option value="${c.key}">${escapeHtml(c.label)}</option>`).join('')}
      </select>
      <label>Additional details (optional)</label>
      <textarea name="reason" placeholder="Anything else that would help us look into this"></textarea>
      <div class="error" id="reportError"></div>
      <button class="primary-btn" type="submit">Submit report</button>
    </form>
  `);
  $('#reportForm').onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    if (!fd.category) { $('#reportError').textContent = 'Please select a reason.'; return; }
    try {
      await api('/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target_type: targetType, target_id: targetId, category: fd.category, reason: fd.reason }) });
      closeModal();
      alert('Thanks — this has been reported.');
    } catch (err) { $('#reportError').textContent = err.message; }
  };
}

// ---------- blocked users (Trust & Safety) ----------
async function openBlockedUsersModal() {
  showModal(`<h2>🚫 Blocked users</h2><p class="hint">People you've blocked won't see your posts, and you won't see theirs.</p><div id="blockedUsersList" style="margin-top:12px">Loading...</div>`);
  const list = $('#blockedUsersList');
  try {
    const users = await api('/api/users/blocked');
    if (!users.length) { list.innerHTML = `<div class="empty">You haven't blocked anyone.</div>`; return; }
    list.innerHTML = users.map(u => `
      <div class="claim-row" data-uid="${escapeHtml(u.id)}">
        <strong>${escapeHtml(u.name)}</strong>${u.is_verified ? ' <span class="verified-badge">✓ Verified</span>' : ''}
        <div class="hint">Blocked ${escapeHtml((u.blocked_at || '').slice(0, 10))}</div>
        <button type="button" class="ghost" data-unblock="${escapeHtml(u.id)}" style="margin-top:8px">Unblock</button>
      </div>`).join('');
    list.querySelectorAll('[data-unblock]').forEach(btn => {
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          await api('/api/users/' + btn.dataset.unblock + '/block', { method: 'DELETE' });
          btn.closest('[data-uid]').remove();
          if (!list.querySelector('[data-uid]')) list.innerHTML = `<div class="empty">You haven't blocked anyone.</div>`;
          loadItems(); loadRequests();
        } catch (err) { btn.disabled = false; alert(err.message || 'Could not unblock this user.'); }
      };
    });
  } catch (e) {
    list.innerHTML = `<div class="empty">Could not load your blocked users.</div>`;
  }
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
          <div class="mini-badge-lg" style="margin-top:6px">${escapeHtml(reportCategoryLabel(r.category))}</div>
          ${r.reason ? `<p class="review-comment">"${escapeHtml(r.reason)}"</p>` : ''}
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
// RESEND COOLDOWN: 30s between sends, client-side only (purely UX — stops someone mashing the
// button and racing the server's own 5-per-15-min verifyLimiter). Not persisted across a modal
// close/reopen or a page reload by design: this is just "don't double-tap", not a security control —
// the real limit that actually matters lives server-side on /api/verify/request.
const VERIFY_RESEND_COOLDOWN_S = 30;

async function openVerifyModal() {
  showModal(`<h2>Verify your account</h2><div id="verifyContent">Loading...</div>`);
  renderVerifyForm(null, true); // true = send the first code automatically on open, like before
}

function renderVerifyForm(infoMessage, autoSend) {
  $('#verifyContent').innerHTML = `
    <p class="hint" id="verifyHint">${infoMessage ? escapeHtml(infoMessage) : `Tap "Send code" to email a 6-digit code to ${escapeHtml(state.user.email)}.`}</p>
    <form id="verifyForm">
      <label>6-digit code</label><input name="code" required maxlength="6" pattern="[0-9]{6}" id="verifyCodeInput" disabled>
      <div class="error" id="verifyError"></div>
      <div class="verify-actions" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <button type="button" class="primary-btn" id="verifySendBtn">Send code</button>
        <button class="primary-btn" type="submit" id="verifyConfirmBtn" disabled>Confirm</button>
      </div>
    </form>
  `;
  let cooldownTimer = null;
  function startCooldown() {
    let remaining = VERIFY_RESEND_COOLDOWN_S;
    const btn = $('#verifySendBtn');
    btn.disabled = true;
    btn.textContent = `Resend code (${remaining}s)`;
    cooldownTimer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(cooldownTimer);
        btn.disabled = false;
        btn.textContent = 'Resend code';
      } else {
        btn.textContent = `Resend code (${remaining}s)`;
      }
    }, 1000);
  }
  async function sendCode() {
    $('#verifyError').textContent = '';
    $('#verifySendBtn').disabled = true;
    try {
      const { demo_code } = await api('/api/verify/request', { method: 'POST' });
      // demo_code is only present outside production (see /api/verify/request in server.js) — in
      // production the code is emailed to the user's own address instead of being returned here.
      $('#verifyHint').innerHTML = demo_code
        ? `DEMO MODE: in production this code would be emailed to you. Your code is <strong>${demo_code}</strong> — enter it below to confirm.`
        : `We emailed a 6-digit code to ${escapeHtml(state.user.email)} — enter it below to confirm.`;
      $('#verifyCodeInput').disabled = false;
      $('#verifyConfirmBtn').disabled = false;
      $('#verifyCodeInput').focus();
      startCooldown();
    } catch (err) {
      // A real server-side rate-limit hit (too many sends) surfaces here with its own message —
      // leave the button enabled so the user can read the error and decide whether to wait/retry,
      // rather than silently re-cooling-down over a request that never actually sent anything.
      $('#verifyError').textContent = err.message;
      $('#verifySendBtn').disabled = false;
    }
  }
  $('#verifySendBtn').onclick = sendCode;
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
  if (autoSend) sendCode();
}

// ---------- impact metrics ----------
async function openImpactModal() {
  showModal(`<h2>Our impact</h2><p class="hint">Live numbers from Zineedo — "Nothing useful should go to waste."</p><div id="impactContent">Loading...</div>`);
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
      ${state.user && state.user.id !== p.id ? `<a href="#" class="report-link" id="reportUserLink">🚩 Report this user</a> <a href="#" class="report-link" id="blockUserLink" style="margin-left:14px">🚫 Block user</a>` : ''}
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
    const blockUserLink = $('#blockUserLink');
    if (blockUserLink) blockUserLink.onclick = async (e) => {
      e.preventDefault();
      if (!confirm(`Block this user?\n\nYou won't see their posts or receive interactions from them. You can unblock them later from Settings.`)) return;
      try {
        await api('/api/users/' + p.id + '/block', { method: 'POST' });
        closeModal();
        alert(`${p.name} has been blocked.`);
        // Their content may now be filtered out of whatever's currently loaded — refresh the
        // relevant lists rather than leaving stale cards on screen.
        loadItems(); loadRequests();
      } catch (err) { alert(err.message || 'Could not block this user.'); }
    };
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
// ---------- My Posts full-page dashboard ----------
// Replaces the old small centered modal with a dedicated full-page workspace. No client-side
// router exists in this app, so this is a page-level container (#myPostsPage in index.html) that
// swaps visibility with <main> — the header and footer stay exactly where they are and are shared,
// not duplicated. A #my-posts hash is pushed purely so the browser back button closes the page.
const myPostsState = { tab: 'all', q: '', status: '', category: '', items: [], requests: [] };

async function loadMyPostsData() {
  const [items, requests] = await Promise.all([
    api('/api/items?mine=' + state.user.id),
    api('/api/requests?mine=' + state.user.id)
  ]);
  myPostsState.items = items;
  myPostsState.requests = requests;
}

function myPostsItemMatchesStatus(item) {
  return !myPostsState.status || item.status === myPostsState.status;
}
function myPostsRequestMatchesStatus(r) {
  const f = myPostsState.status;
  if (!f) return true;
  if (f === 'available') return r.status === 'open';
  if (f === 'claimed') return false; // requests have no "claimed" state
  if (f === 'closed') return r.status === 'closed' || r.status === 'fulfilled';
  return true;
}

function myPostsFilteredLists() {
  const q = myPostsState.q.trim().toLowerCase();
  const cat = myPostsState.category;
  let items = (myPostsState.tab === 'requests' || myPostsState.tab === 'services') ? [] : myPostsState.items;
  let requests = (myPostsState.tab === 'items') ? [] : myPostsState.requests;
  if (myPostsState.tab === 'requests') requests = requests.filter(r => r.request_type !== 'service');
  if (myPostsState.tab === 'services') requests = requests.filter(r => r.request_type === 'service');
  items = items.filter(it => (!q || it.title.toLowerCase().includes(q)) && myPostsItemMatchesStatus(it) && (!cat || displayCategory(it.category) === cat));
  requests = requests.filter(r => (!q || r.title.toLowerCase().includes(q)) && myPostsRequestMatchesStatus(r) && (!cat || displayCategory(r.category) === cat));
  return { items, requests };
}

// One place that decides the "Open / Offer received / Accepted / Declined / Completed" vocabulary
// for a claim or request-offer row in the Activity dashboard, reused across all four tabs so item
// claims and request offers read identically. `side` is 'received' (viewer is the owner deciding)
// or 'sent' (viewer is the one who asked/offered) — only changes the pending label's wording.
function flowStatusBadgeHtml(status, side) {
  const map = {
    pending: { label: side === 'received' ? 'Offer received' : 'Pending', cls: 'pending' },
    accepted: { label: 'Accepted', cls: 'accepted' },
    declined: { label: 'Declined', cls: 'declined' },
    completed: { label: 'Completed', cls: 'completed' },
    not_completed: { label: 'Not completed', cls: 'declined' }
  };
  const m = map[status] || { label: titleCase(status), cls: 'pending' };
  return `<span class="badge my-post-status ${m.cls}">${m.label}</span>`;
}

function myPostStatusBadgeHtml(status) {
  if (status === 'closed') return `<span class="badge my-post-status completed">Completed</span>`;
  if (status === 'claimed') return `<span class="badge my-post-status claimed">Claimed</span>`;
  return `<span class="badge my-post-status active">Active</span>`;
}
function myPostRequestStatusBadgeHtml(status) {
  if (status === 'closed' || status === 'fulfilled') return `<span class="badge my-post-status completed">Completed</span>`;
  return `<span class="badge my-post-status active">Active</span>`;
}

// Item card — reuses the existing .card base class + thumbInnerHtml/itemPriceLabel helpers so
// photos, price labels, and the no-photo fallback all look/behave exactly like they do elsewhere;
// only the extra .my-post-card modifier and management actions are new.
function myPostCardHtml(item) {
  return `<div class="card my-post-card" data-id="${item.id}" data-kind="item">
    <div class="thumb">
      ${thumbInnerHtml(item)}
      <span class="price-badge ${itemPriceBadgeClass(item)}">${itemPriceLabel(item)}</span>
    </div>
    <div class="body">
      <h3>${escapeHtml(item.title)}</h3>
      <div class="meta">${escapeHtml(displayCategory(item.category))}</div>
      <div class="meta">${LOC_SVG}${escapeHtml(item.owner_location || 'Nearby')} &middot; ${timeAgo(item.created_at)}</div>
      <div class="my-post-status-row">${myPostStatusBadgeHtml(item.status)}</div>
      <div class="my-post-actions">
        <button type="button" class="my-post-action-btn primary" data-act="view">View</button>
        <button type="button" class="my-post-action-btn" data-act="edit">Edit</button>
        <div class="my-post-more-wrap">
          <button type="button" class="my-post-more-btn" data-act="more" aria-label="More actions">&#8942;</button>
          <div class="my-post-more-menu" style="display:none">
            ${item.status !== 'closed' ? `<button type="button" data-act="unavailable">Mark as unavailable</button>` : ''}
            <button type="button" data-act="delete" class="danger">Delete</button>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

// Request/service-request card — deliberately different treatment (tag pill instead of a photo
// thumb, since requests have no images) so it's immediately clear this is "something I asked for",
// matching the existing requestCardHtml/requestBadgeHtml pattern used elsewhere in the app.
function myPostRequestCardHtml(r) {
  const isService = r.request_type === 'service';
  return `<div class="card my-post-card my-post-request-card" data-id="${r.id}" data-kind="request">
    <div class="my-post-request-tag">${isService ? 'SERVICE REQUEST' : 'REQUEST'}</div>
    <div class="body">
      <h3>${escapeHtml(r.title)}</h3>
      <div class="meta">${escapeHtml(displayCategory(r.category))}</div>
      <div class="meta">${LOC_SVG}${escapeHtml(r.owner_location || 'Nearby')} &middot; ${timeAgo(r.created_at)}</div>
      <div class="my-post-status-row">${myPostRequestStatusBadgeHtml(r.status)}</div>
      <div class="my-post-actions">
        <button type="button" class="my-post-action-btn primary" data-act="view">View request &rarr;</button>
        ${r.status !== 'closed' ? `<div class="my-post-more-wrap">
          <button type="button" class="my-post-more-btn" data-act="more" aria-label="More actions">&#8942;</button>
          <div class="my-post-more-menu" style="display:none">
            <button type="button" data-act="unavailable">Mark as closed</button>
          </div>
        </div>` : ''}
      </div>
    </div>
  </div>`;
}

const MY_POSTS_EMPTY_COPY = {
  all: "Be the first to give something a new home.",
  items: "You haven't posted any items yet.",
  requests: "You haven't posted any requests yet.",
  services: "You haven't posted any service requests yet."
};
function myPostsEmptyHtml() {
  return `<div class="my-posts-empty-inner">
    <div class="my-posts-empty-icon"><i data-lucide="sprout"></i></div>
    <h3>Nothing posted yet</h3>
    <p>${MY_POSTS_EMPTY_COPY[myPostsState.tab] || MY_POSTS_EMPTY_COPY.all}</p>
    <button type="button" class="primary-btn" id="myPostsEmptyPostBtn"><i data-lucide="plus"></i> Post an item</button>
  </div>`;
}

function renderMyPostsStats() {
  const allItems = myPostsState.items, allRequests = myPostsState.requests;
  const total = allItems.length + allRequests.length;
  const active = allItems.filter(i => i.status === 'available').length + allRequests.filter(r => r.status === 'open').length;
  const completed = allItems.filter(i => i.status === 'closed').length + allRequests.filter(r => r.status === 'closed' || r.status === 'fulfilled').length;
  $('#myPostsStats').innerHTML = `
    <div class="my-posts-stat"><strong>${total}</strong><span>Total posts</span></div>
    <div class="my-posts-stat"><strong>${active}</strong><span>Active</span></div>
    <div class="my-posts-stat"><strong>${allRequests.length}</strong><span>Requests</span></div>
    <div class="my-posts-stat"><strong>${completed}</strong><span>Completed</span></div>
  `;
}

function bindMyPostsCardActions(grid, items, requests) {
  grid.querySelectorAll('.my-post-card').forEach(card => {
    const id = card.dataset.id, kind = card.dataset.kind;
    const record = kind === 'item' ? items.find(i => String(i.id) === id) : requests.find(r => String(r.id) === id);
    if (!record) return;
    const viewBtn = card.querySelector('[data-act="view"]');
    if (viewBtn) viewBtn.onclick = () => kind === 'item' ? openDetail(record.id) : openRequestDetail(record.id);
    const editBtn = card.querySelector('[data-act="edit"]');
    if (editBtn) editBtn.onclick = () => openEditModal(record); // items only — no edit UI exists for requests today
    const moreBtn = card.querySelector('[data-act="more"]');
    const moreMenu = card.querySelector('.my-post-more-menu');
    if (moreBtn && moreMenu) {
      moreBtn.onclick = (e) => {
        e.stopPropagation();
        const willOpen = moreMenu.style.display !== 'block';
        grid.querySelectorAll('.my-post-more-menu').forEach(m => m.style.display = 'none');
        moreMenu.style.display = willOpen ? 'block' : 'none';
      };
      const unavailBtn = moreMenu.querySelector('[data-act="unavailable"]');
      if (unavailBtn) unavailBtn.onclick = async (e) => {
        e.stopPropagation();
        const url = kind === 'item' ? '/api/items/' + record.id : '/api/requests/' + record.id;
        await api(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'closed' }) });
        await loadMyPostsData();
        renderMyPosts();
      };
      const delBtn = moreMenu.querySelector('[data-act="delete"]'); // items only — no delete endpoint exists for requests today
      if (delBtn) delBtn.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm('Delete this post? This cannot be undone.')) return;
        await api('/api/items/' + record.id, { method: 'DELETE' });
        await loadMyPostsData();
        renderMyPosts();
      };
    }
  });
  document.addEventListener('click', () => grid.querySelectorAll('.my-post-more-menu').forEach(m => m.style.display = 'none'), { once: true });
}

function renderMyPostsGrid(items, requests) {
  const grid = $('#myPostsGrid'), emptyEl = $('#myPostsEmpty');
  const cards = [...items.map(myPostCardHtml), ...requests.map(myPostRequestCardHtml)];
  if (!cards.length) {
    grid.style.display = 'none';
    grid.innerHTML = '';
    emptyEl.style.display = 'block';
    emptyEl.innerHTML = myPostsEmptyHtml();
    const btn = $('#myPostsEmptyPostBtn'); if (btn) btn.onclick = () => $('#postBtn').click();
  } else {
    emptyEl.style.display = 'none';
    grid.style.display = 'grid';
    grid.innerHTML = cards.join('');
    bindMyPostsCardActions(grid, items, requests);
  }
  if (window.lucide) lucide.createIcons();
}

function renderMyPosts() {
  const { items, requests } = myPostsFilteredLists();
  renderMyPostsStats();
  renderMyPostsGrid(items, requests);
}

function populateMyPostsCategoryFilter() {
  const cats = new Set();
  myPostsState.items.forEach(i => cats.add(displayCategory(i.category)));
  myPostsState.requests.forEach(r => cats.add(displayCategory(r.category)));
  const sel = $('#myPostsCategoryFilter');
  const current = sel.value;
  sel.innerHTML = '<option value="">Category</option>' + [...cats].sort().map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  sel.value = current && cats.has(current) ? current : '';
}

function bindMyPostsControls() {
  $('#myPostsBackBtn').onclick = () => closeMyPostsPage();
  $('#myPostsPostBtn').onclick = () => $('#postBtn').click();
  document.querySelectorAll('#myPostsTabs .my-posts-tab').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('#myPostsTabs .my-posts-tab').forEach(b => b.classList.toggle('active', b === btn));
      myPostsState.tab = btn.dataset.tab;
      renderMyPosts();
    };
  });
  const searchInput = $('#myPostsSearch');
  searchInput.value = myPostsState.q;
  searchInput.oninput = debounce(() => { myPostsState.q = searchInput.value; renderMyPosts(); }, 200);
  $('#myPostsStatusFilter').onchange = (e) => { myPostsState.status = e.target.value; renderMyPosts(); };
  $('#myPostsCategoryFilter').onchange = (e) => { myPostsState.category = e.target.value; renderMyPosts(); };
}

// ---------- generic "homepage overlay page" mechanism ----------
// A homepage overlay page (My Posts, My Profile, ...) is a section INSIDE <main> (see index.html),
// sibling to all the homepage content divs. Opening/closing one never hides <main> itself — that
// would put <main> (empty) between header and footer but wouldn't fix anything structurally;
// instead it toggles which of main's direct children are visible, so <main> (and therefore the
// header -> main -> footer document order) is always intact. Every homepage child's own inline
// style is remembered before being hidden and restored exactly on close, so nothing about the
// homepage's own layout is altered by this toggle. Only one overlay page is open at a time —
// opening a second one automatically closes whichever was open, no separate "switch pages" logic
// needed. Originally written just for My Posts; generalized so My Profile can reuse it exactly
// rather than duplicating this same show/hide logic a second time.
let openOverlayPageId = null;
const OVERLAY_PAGE_ACTIVE_SELECTORS = { myPostsPage: '#myItemsBtn' };
const OVERLAY_PAGE_HASHES = { myPostsPage: '#my-posts', myProfilePage: '#my-profile' };

function isOverlayPageOpen(pageId) {
  return openOverlayPageId === pageId;
}

// AUDIT FIX: opening My Posts (or My Profile) never cleared whichever top .section-tab (Give &
// Take / Business Surplus / Requests) was active beforehand — since .my-posts-page/.my-profile-page
// render inline below the header rather than as a full-screen overlay, that stale-active tab stayed
// visibly green/underlined at the same time as #myItemsBtn, making it look like two different pages
// were "current" at once. Remembers which section-tab was active before the overlay opened and
// restores it on close; nothing else about section-tab behavior changes.
let sectionTabActiveBeforeOverlay = null;
// PHASE 7 MOBILE AUDIT FIX: the desktop half of this same bug (My Posts leaving a stale
// .section-tab looking active) was already fixed in an earlier phase, but the equivalent mobile
// bottom-nav item was never touched by this function at all — opening My Posts/My Profile via the
// Profile sheet's bottom-nav entry point left whichever of Home/Browse/Requests was tapped last
// still visually highlighted, while the actual "Profile" bottom-nav item never lit up. This is the
// specific issue Phase 7 was asked to recheck; it was still present. Mirrors the exact same
// remember-and-restore pattern already used for sectionTabActiveBeforeOverlay above.
let bottomNavActiveBeforeOverlay = null;
function setOverlayActiveIndicator(pageId) {
  Object.values(OVERLAY_PAGE_ACTIVE_SELECTORS).forEach(sel => $(sel)?.classList.remove('active'));
  const sel = pageId && OVERLAY_PAGE_ACTIVE_SELECTORS[pageId];
  if (sel) $(sel)?.classList.add('active');

  if (pageId) {
    if (!sectionTabActiveBeforeOverlay) {
      sectionTabActiveBeforeOverlay = document.querySelector('.section-tab.active') || null;
    }
    document.querySelectorAll('.section-tab').forEach(b => b.classList.remove('active'));
    if (!bottomNavActiveBeforeOverlay) {
      bottomNavActiveBeforeOverlay = document.querySelector('.bottom-nav-item.active') || null;
    }
    document.querySelectorAll('.bottom-nav-item').forEach(b => b.classList.toggle('active', b.dataset.bn === 'profile'));
  } else {
    if (sectionTabActiveBeforeOverlay) sectionTabActiveBeforeOverlay.classList.add('active');
    sectionTabActiveBeforeOverlay = null;
    document.querySelectorAll('.bottom-nav-item').forEach(b => b.classList.remove('active'));
    if (bottomNavActiveBeforeOverlay) bottomNavActiveBeforeOverlay.classList.add('active');
    bottomNavActiveBeforeOverlay = null;
  }
}

function showHomepageOverlayPage(pageId) {
  const mainEl = document.querySelector('main');
  if (!mainEl) return;
  Array.from(mainEl.children).forEach(el => {
    if (el.id === pageId) { el.style.display = 'block'; return; }
    if (el.dataset.overlayPrevDisplay === undefined) el.dataset.overlayPrevDisplay = el.style.display || '';
    el.style.display = 'none';
  });
  openOverlayPageId = pageId;
  setOverlayActiveIndicator(pageId);
}

function hideHomepageOverlayPage() {
  const mainEl = document.querySelector('main');
  if (!mainEl) return;
  Array.from(mainEl.children).forEach(el => {
    if (el.dataset.overlayPrevDisplay !== undefined) {
      el.style.display = el.dataset.overlayPrevDisplay;
      delete el.dataset.overlayPrevDisplay;
    } else if (el.id === openOverlayPageId) {
      el.style.display = 'none';
    }
  });
  openOverlayPageId = null;
  setOverlayActiveIndicator(null);
}

// Used by every global-nav action (section tabs, More menu, mobile bottom nav) so that clicking
// Give & Take / Business Surplus / Requests / any homepage-section shortcut while on My Posts or
// My Profile always restores the homepage first, instead of silently updating hidden DOM the user
// can't see.
function ensureHomepageVisible() {
  if (openOverlayPageId) hideHomepageOverlayPage();
}

// Back-button support: if an overlay page is open and the user navigates back, close it instead of
// leaving a stale hash. Homepage navigation never touches this listener.
window.addEventListener('popstate', () => {
  if (openOverlayPageId && location.hash !== OVERLAY_PAGE_HASHES[openOverlayPageId]) hideHomepageOverlayPage();
});

function closeMyPostsPage() {
  if (!isOverlayPageOpen('myPostsPage')) return;
  hideHomepageOverlayPage();
  if (location.hash === '#my-posts') history.back();
}

async function openMyPosts() {
  if (!state.user) { closeModal(); return openAuthModal('login'); }
  closeModal();
  myPostsState.tab = 'all'; myPostsState.q = ''; myPostsState.status = ''; myPostsState.category = '';
  document.querySelectorAll('#myPostsTabs .my-posts-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === 'all'));
  showHomepageOverlayPage('myPostsPage');
  window.scrollTo(0, 0);
  if (location.hash !== '#my-posts') history.pushState(null, '', '#my-posts');
  $('#myPostsStats').innerHTML = '';
  $('#myPostsGrid').innerHTML = '';
  $('#myPostsEmpty').style.display = 'none';
  bindMyPostsControls();
  if (window.lucide) lucide.createIcons();
  await loadMyPostsData();
  populateMyPostsCategoryFilter();
  renderMyPosts();
}

function closeMyProfilePage() {
  if (!isOverlayPageOpen('myProfilePage')) return;
  hideHomepageOverlayPage();
  if (location.hash === '#my-profile') history.back();
}

// My Profile: full-page version of the existing "view other user's profile" modal (openProfileModal).
// Reuses the same GET /api/users/:id/profile endpoint and the same .profile-header/.profile-stats/
// .profile-rating/.profile-badges/.review-row markup and CSS classes -- no new backend, no fake data.
// Edit Profile / Address / Password & Security are intentionally omitted (no backend support yet,
// per user decision to skip those for this pass).
async function openMyProfile() {
  if (!state.user) { closeModal(); return openAuthModal('login'); }
  closeModal();
  showHomepageOverlayPage('myProfilePage');
  window.scrollTo(0, 0);
  if (location.hash !== '#my-profile') history.pushState(null, '', '#my-profile');
  $('#myProfileBackBtn').onclick = () => closeMyProfilePage();
  const content = $('#myProfileContent');
  content.innerHTML = 'Loading...';
  try {
    const p = await api('/api/users/' + state.user.id + '/profile');
    content.innerHTML = `
      <div class="profile-header">
        <div class="profile-name">${escapeHtml(p.name)}${p.is_verified ? ` <span class="owner-check" title="Verified">${CHECK_SVG}</span>` : ''} ${p.account_type === 'business' ? '<span class="owner-badge">Business</span>' : '<span class="owner-badge">Individual</span>'}</div>
        <div class="hint">📍 ${escapeHtml(p.location || 'Location not set')}</div>
        <div class="hint">${p.member_since ? 'Member since ' + escapeHtml(p.member_since) : ''}</div>
        <button type="button" class="my-profile-edit-btn" id="myProfileEditBtn"><i data-lucide="pencil"></i> Edit profile</button>
      </div>
      <div class="profile-rating">${starsDisplayHtml(p.avg_rating)}${p.rating_count ? ` <span class="hint">(${p.rating_count} review${p.rating_count === 1 ? '' : 's'})</span>` : ''}</div>
      ${p.badges.length ? `<div class="profile-badges">${p.badges.map(b => `<span class="mini-badge-lg">${PROFILE_BADGE_LABELS[b] || b}</span>`).join(' ')} <span class="hint">· ${escapeHtml(p.badge_month)}</span></div>` : ''}
      <div class="profile-stats">
        <div class="profile-stat"><div class="num">${p.reuse_count}</div><div class="label">Successful reuses</div></div>
        <div class="profile-stat"><div class="num">${p.food_count}</div><div class="label">Food donations</div></div>
        <div class="profile-stat"><div class="num">${p.total_count}</div><div class="label">Total contributions</div></div>
      </div>
      <h3 style="margin-top:18px">Recent reviews</h3>
      <div class="hint" style="margin-bottom:8px">Reviewer identities are kept anonymous.</div>
      ${p.recent_reviews.length ? p.recent_reviews.map(r => `
        <div class="review-row">
          <div class="stars-display">${'★'.repeat(r.stars)}${'☆'.repeat(5 - r.stars)}</div>
          ${r.tags.length ? `<div class="review-tags">${r.tags.map(t => `<span class="badge">${escapeHtml(tagLabel(t))}</span>`).join(' ')}</div>` : ''}
          ${r.comment ? `<p class="review-comment">"${escapeHtml(r.comment)}"</p>` : ''}
        </div>`).join('') : `<div class="empty">No reviews yet.</div>`}
    `;
    if (window.lucide) lucide.createIcons();
    $('#myProfileEditBtn').onclick = () => renderMyProfileEditForm(p);
  } catch (e) {
    content.innerHTML = `<div class="empty">Could not load your profile.</div>`;
  }
}

// Edit Profile form: name + location only (see PATCH /api/me on the server — email/account_type
// aren't editable here, same scope decision already made for the rest of the account system).
// PHASE 2 — LOCATION PICKER: the plain free-text location input is upgraded (not replaced with a
// competing UI) to a read-only display + "Change location" button that opens the new picker modal.
// Typing a location by hand is still fully supported — the picker's manual search IS a text
// search, just one that resolves to a real geocoded place instead of an arbitrary unverified
// string. pendingLocationSelection holds whatever the picker most recently confirmed (or null if
// the user hasn't touched it this edit session, in which case the existing location is unchanged).
function renderMyProfileEditForm(p) {
  const content = $('#myProfileContent');
  let pendingLocationSelection = null; // { label, lat, lng, source } | null
  const currentLocationLabel = () => pendingLocationSelection ? pendingLocationSelection.label : (p.location || 'Not set');
  content.innerHTML = `
    <form id="myProfileEditForm" novalidate>
      <label for="editProfileName">Full name</label>
      <input id="editProfileName" name="name" required minlength="1" maxlength="80" value="${escapeHtml(p.name)}">
      <label>Location</label>
      <div class="location-field-display">
        <span id="editProfileLocationLabel">📍 ${escapeHtml(currentLocationLabel())}</span>
        <button type="button" class="ghost" id="editProfileChangeLocationBtn">Change location</button>
      </div>
      <div class="error" id="editProfileError" role="alert" aria-live="polite"></div>
      <div style="display:flex;gap:10px;margin-top:12px">
        <button class="primary-btn" type="submit">Save changes</button>
        <button class="my-profile-edit-cancel" type="button" id="editProfileCancelBtn">Cancel</button>
      </div>
    </form>
  `;
  $('#editProfileCancelBtn').onclick = () => openMyProfile();
  $('#editProfileChangeLocationBtn').onclick = () => {
    openLocationPickerModal(p.location || '', (selection) => {
      // selection: { label, lat, lng, source } — the modal already closed itself before calling
      // this; nothing is saved to the server yet, only held here until "Save changes" is submitted,
      // matching the rest of this form's existing save-on-submit behavior.
      pendingLocationSelection = selection;
      $('#editProfileLocationLabel').textContent = `📍 ${selection.label}`;
    });
  };
  $('#myProfileEditForm').onsubmit = async (e) => {
    e.preventDefault();
    const errEl = $('#editProfileError');
    errEl.textContent = '';
    const name = $('#editProfileName').value.trim();
    if (!name) { errEl.textContent = 'Name is required.'; return; }
    const body = { name };
    if (pendingLocationSelection) {
      body.location = pendingLocationSelection.label;
      body.location_lat = pendingLocationSelection.lat;
      body.location_lng = pendingLocationSelection.lng;
      body.location_source = pendingLocationSelection.source;
      if (pendingLocationSelection.precision) body.location_precision = pendingLocationSelection.precision;
    }
    try {
      const { user } = await api('/api/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      state.user = user;
      renderNav();
      await openMyProfile();
    } catch (err) {
      errEl.textContent = err.message || 'Could not save changes.';
    }
  };
}

// ---------- Phase 2: Location Picker modal (reusable) ----------
// onConfirm(selection) is called with { label, lat, lng, source, precision } only after the user
// explicitly clicks "Confirm location" — nothing is sent anywhere by this modal itself; the caller
// decides what to do with the confirmed selection (here, holding it until the surrounding form is
// saved). Cancelling (closing the modal without confirming) leaves the caller's existing location
// completely untouched, since onConfirm is simply never called.
function openLocationPickerModal(currentLocationText, onConfirm) {
  showModal(`
    <h2>📍 Choose your location</h2>
    <p class="hint">Used to show relevant nearby content. This is your general area — not an exact address.</p>
    <button type="button" class="primary-btn" id="locPickerUseCurrentBtn" style="width:100%;margin:14px 0">Use my current location</button>
    <div class="error" id="locPickerGeoError" role="alert" aria-live="polite"></div>
    <label for="locPickerSearchInput">Search for a city, area or locality</label>
    <input id="locPickerSearchInput" placeholder="e.g. Hyderabad, Kukatpally, Chennai" autocomplete="off">
    <div id="locPickerResults" style="margin-top:8px"></div>
    <div id="locPickerConfirm" style="margin-top:14px"></div>
    <div class="hint" style="margin-top:10px;text-align:center">Powered by Geoapify &middot; &copy; OpenStreetMap contributors</div>
  `);
  const resultsEl = $('#locPickerResults');
  const confirmEl = $('#locPickerConfirm');
  const geoErrorEl = $('#locPickerGeoError');

  function renderConfirmStep(selection) {
    confirmEl.innerHTML = `
      <div class="location-confirm-box">
        <div class="hint">Selected location</div>
        <div class="location-confirm-label">📍 ${escapeHtml(selection.label)}</div>
        <button type="button" class="primary-btn" id="locPickerConfirmBtn" style="margin-top:10px">Confirm location</button>
      </div>
    `;
    $('#locPickerConfirmBtn').onclick = () => {
      closeModal();
      onConfirm(selection);
    };
  }

  function renderResults(results) {
    if (!results.length) { resultsEl.innerHTML = ''; return; }
    resultsEl.innerHTML = results.map((r, i) => `<button type="button" class="location-result-row" data-i="${i}">📍 ${escapeHtml(r.label)}</button>`).join('');
    resultsEl.querySelectorAll('.location-result-row').forEach((btn, i) => {
      btn.onclick = () => {
        resultsEl.innerHTML = '';
        $('#locPickerSearchInput').value = results[i].label;
        renderConfirmStep({ label: results[i].label, lat: results[i].lat, lng: results[i].lng, source: 'search', precision: results[i].precision });
      };
    });
  }

  const runSearch = debounce(async (q) => {
    confirmEl.innerHTML = '';
    if (!q.trim()) { resultsEl.innerHTML = ''; return; }
    resultsEl.innerHTML = `<div class="hint">Searching…</div>`;
    try {
      const res = await fetch('/api/location/search?q=' + encodeURIComponent(q), { credentials: 'include' });
      const data = await res.json();
      if (data.status === 'ok') {
        renderResults(data.results);
      } else if (data.status === 'not_found') {
        resultsEl.innerHTML = `<div class="hint">No matches found. Try a different spelling or a nearby larger area.</div>`;
      } else if (data.status === 'rate_limited') {
        resultsEl.innerHTML = `<div class="hint">Too many searches right now — please wait a moment and try again.</div>`;
      } else if (data.status === 'not_configured') {
        resultsEl.innerHTML = `<div class="hint">Location search isn't available right now. You can still save a location by typing it as free text via "Use my current location" or contact support.</div>`;
      } else {
        resultsEl.innerHTML = `<div class="hint">Couldn't search right now. Please try again in a moment.</div>`;
      }
    } catch {
      resultsEl.innerHTML = `<div class="hint">Couldn't reach the location service. Please check your connection and try again.</div>`;
    }
  }, 350);
  $('#locPickerSearchInput').oninput = (e) => runSearch(e.target.value);

  $('#locPickerUseCurrentBtn').onclick = () => {
    geoErrorEl.textContent = '';
    // A truthy check (not just `'geolocation' in navigator`) so this also catches a browser/test
    // environment where the property exists but is null/undefined, not only one where it's absent
    // entirely — both mean "can't use this", and only a truthy check safely handles both.
    if (!navigator.geolocation) {
      geoErrorEl.textContent = "Your browser doesn't support location detection. You can search for your city or area instead.";
      return;
    }
    const btn = $('#locPickerUseCurrentBtn');
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = 'Detecting your location…';
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        btn.disabled = false; btn.textContent = originalText;
        const { latitude, longitude } = position.coords;
        // Client-side range check is just a fast, friendly first line of defense — the server
        // re-validates independently and is the actual boundary (see POST /api/location/reverse).
        if (typeof latitude !== 'number' || typeof longitude !== 'number' ||
            latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
          geoErrorEl.textContent = "Couldn't determine your location. You can search for your city or area instead.";
          return;
        }
        try {
          const res = await fetch('/api/location/reverse', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ lat: latitude, lng: longitude }) });
          const data = await res.json();
          if (data.status === 'ok') {
            renderConfirmStep({ label: data.label, lat: latitude, lng: longitude, source: 'gps', precision: 'approximate' });
          } else if (data.status === 'rate_limited') {
            geoErrorEl.textContent = 'Too many attempts right now — please wait a moment and try again.';
          } else if (data.status === 'not_configured') {
            geoErrorEl.textContent = "Location detection isn't available right now. You can search for your city or area instead.";
          } else {
            geoErrorEl.textContent = "Couldn't determine your location. You can search for your city or area instead.";
          }
        } catch {
          geoErrorEl.textContent = "Couldn't reach the location service. You can search for your city or area instead.";
        }
      },
      (error) => {
        btn.disabled = false; btn.textContent = originalText;
        // GeolocationPositionError codes: 1 = PERMISSION_DENIED, 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT.
        if (error.code === 1) geoErrorEl.textContent = "Location permission denied. You can search for your city or area instead.";
        else if (error.code === 2) geoErrorEl.textContent = "Couldn't determine your location right now. You can search for your city or area instead.";
        else if (error.code === 3) geoErrorEl.textContent = "Location request timed out. You can search for your city or area instead.";
        else geoErrorEl.textContent = "Couldn't determine your location. You can search for your city or area instead.";
      },
      { timeout: 10000, maximumAge: 0 }
    );
  };
}

// Saved Items: state.wishlist is an in-memory Set of item ids toggled by the heart button on any
// item card (see bindWishlistButtons) — it has never been persisted server-side, so this modal
// shows exactly what it is: the items you've hearted this session, fetched fresh by id from the
// real GET /api/items/:id endpoint (same one openDetail uses). No new backend, no fake data.
async function openSavedItemsModal() {
  if (!state.user) { closeModal(); return openAuthModal('login'); }
  const ids = [...state.wishlist];
  showModal(`<h2>❤️ Saved Items</h2><p class="hint">Items you've saved on this device.</p><div id="savedItemsGrid" class="grid" style="margin-top:12px"></div>`);
  const grid = $('#savedItemsGrid');
  if (!ids.length) {
    grid.innerHTML = `<div class="empty">You haven't saved any items yet. Tap the heart on any item to save it here.</div>`;
    return;
  }
  grid.innerHTML = 'Loading...';
  try {
    const items = (await Promise.all(ids.map(id => api('/api/items/' + id).catch(() => null)))).filter(Boolean);
    if (!items.length) { grid.innerHTML = `<div class="empty">Your saved items are no longer available.</div>`; return; }
    grid.innerHTML = items.map(cardHtml).join('');
    grid.querySelectorAll('.card').forEach(c => c.onclick = () => { closeModal(); openDetail(c.dataset.id); });
    // Unhearting here always means "remove from this list" (everything shown is already saved).
    grid.querySelectorAll('.wishlist-btn').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        state.wishlist.delete(btn.dataset.wish);
        saveWishlistToStorage();
        btn.closest('.card').remove();
        if (!grid.querySelector('.card')) grid.innerHTML = `<div class="empty">You haven't saved any items yet. Tap the heart on any item to save it here.</div>`;
      };
    });
  } catch (e) {
    grid.innerHTML = `<div class="empty">Could not load your saved items.</div>`;
  }
}

// My Impact: personal contribution numbers, reusing the same GET /api/users/:id/profile endpoint
// as My Profile (not a second data source). The CO2/trees figures use the exact multipliers
// already shown on the community Impact Tracker (loadEcoPanel), just applied to this user's own
// total_count instead of the sitewide total — clearly labeled as estimates, same as elsewhere.
async function openMyImpactModal() {
  if (!state.user) { closeModal(); return openAuthModal('login'); }
  showModal(`<h2>🌱 My Impact</h2><p class="hint">Your personal contribution to Zineedo.</p><div id="myImpactContent">Loading...</div>`);
  try {
    const p = await api('/api/users/' + state.user.id + '/profile');
    const reused = p.total_count || 0;
    $('#myImpactContent').innerHTML = `
      <div class="impact-grid">
        <div class="impact-stat"><div class="num">${p.reuse_count}</div><div class="label">Successful reuses</div></div>
        <div class="impact-stat"><div class="num">${p.food_count}</div><div class="label">Food donations</div></div>
        <div class="impact-stat"><div class="num">${p.total_count}</div><div class="label">Total contributions</div></div>
        <div class="impact-stat"><div class="num">${Math.round(reused * 4.2)}</div><div class="label">Est. CO₂ saved (kg)</div></div>
        <div class="impact-stat"><div class="num">${Math.round(reused / 15) || (reused > 0 ? 1 : 0)}</div><div class="label">Est. trees saved</div></div>
      </div>
      <p class="hint" style="margin-top:12px">CO₂ and tree figures are estimates using the same multipliers as Zineedo's community Impact Tracker, applied to your own contributions.</p>
    `;
  } catch (e) {
    $('#myImpactContent').innerHTML = `<div class="empty">Could not load your impact.</div>`;
  }
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

// Shared Accept/Decline wiring for both "item requests received" (claims) and "offers received" —
// same PATCH-to-accept/decline shape on both (/api/claims/:id or /api/request-offers/:id) and the
// same failure modes (duplicate accept after the item/request already moved to someone else, a
// network error) — one implementation covers both instead of duplicating loading/error handling.
// AUDIT FIX: previously neither tab's Accept/Decline buttons had any try/catch at all, so a rejected
// PATCH (e.g. "This item is no longer available" when a second offer is accepted after the first)
// threw an unhandled promise rejection with zero visible feedback — the buttons just sat there,
// looking like nothing happened. Also previously had no disabled state, so a double-click/double-tap
// could fire the PATCH twice.
function bindAcceptDeclineButtons(el, urlBase, onDone) {
  el.querySelectorAll('.claim-row').forEach(row => {
    const buttons = [...row.querySelectorAll('button[data-id]')];
    if (!buttons.length) return;
    buttons.forEach(btn => {
      btn.onclick = async () => {
        if (btn.disabled) return;
        buttons.forEach(b => b.disabled = true);
        const original = btn.textContent;
        btn.textContent = btn.dataset.status === 'accepted' ? 'Accepting…' : 'Declining…';
        let errorEl = row.querySelector('.accept-decline-error');
        if (!errorEl) {
          errorEl = document.createElement('div');
          errorEl.className = 'error accept-decline-error';
          row.querySelector('.actions').insertAdjacentElement('afterend', errorEl);
        }
        errorEl.textContent = '';
        try {
          await api(`${urlBase}/${btn.dataset.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: btn.dataset.status }) });
          showToast(btn.dataset.status === 'accepted' ? 'Accepted!' : 'Declined.', 'success');
          onDone();
        } catch (err) {
          errorEl.textContent = err.message || 'Something went wrong. Please try again.';
          buttons.forEach(b => b.disabled = false);
          btn.textContent = original;
        }
      };
    });
  });
}

function bindConfirmBlocks(el, onDone) {
  el.querySelectorAll('.confirm-block').forEach(block => {
    const kind = block.dataset.kind, id = block.dataset.cid;
    const url = `/api/${kind === 'claim' ? 'claims' : 'request-offers'}/${id}/confirm`;
    // Same disable-while-submitting + inline-error pattern as bindAcceptDeclineButtons above —
    // previously these three buttons had no loading state and no error handling at all.
    function errorBox() {
      let el2 = block.querySelector('.confirm-error');
      if (!el2) {
        el2 = document.createElement('div');
        el2.className = 'error confirm-error';
        block.appendChild(el2);
      }
      return el2;
    }
    const yesBtn = block.querySelector('.confirm-yes');
    const noBtn = block.querySelector('.confirm-no');
    yesBtn.onclick = async () => {
      if (yesBtn.disabled) return;
      yesBtn.disabled = true; noBtn.disabled = true;
      const original = yesBtn.textContent;
      yesBtn.textContent = 'Confirming…';
      try {
        await api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed: true }) });
        onDone();
      } catch (err) {
        errorBox().textContent = err.message || 'Something went wrong. Please try again.';
        yesBtn.disabled = false; noBtn.disabled = false;
        yesBtn.textContent = original;
      }
    };
    noBtn.onclick = () => {
      block.querySelector('.actions').style.display = 'none';
      block.querySelector('.confirm-reason').style.display = 'flex';
    };
    const submitBtn = block.querySelector('.confirm-no-submit');
    submitBtn.onclick = async () => {
      if (submitBtn.disabled) return;
      submitBtn.disabled = true;
      const original = submitBtn.textContent;
      submitBtn.textContent = 'Submitting…';
      const reason = block.querySelector('.reason-select').value;
      try {
        await api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed: false, reason }) });
        onDone();
      } catch (err) {
        errorBox().textContent = err.message || 'Something went wrong. Please try again.';
        submitBtn.disabled = false;
        submitBtn.textContent = original;
      }
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
    // Privacy tiering: before you accept, you see who's interested (name, verified badge, their
    // message) but not their email — same server-enforced rule as everywhere else in the app. Once
    // accepted, contact info becomes genuinely necessary, so it's shown then.
    el.innerHTML = claims.length ? claims.map(c => `
      <div class="claim-row">
        <div class="claim-row-head"><strong>${escapeHtml(c.item_title)}</strong>${flowStatusBadgeHtml(c.status, 'received')}</div>
        <div class="hint">From <button type="button" class="owner-name-link" data-uid="${escapeHtml(c.requester_id)}">${escapeHtml(c.requester_name)}</button>${c.requester_verified ? ' <span class="verified-badge">✓ Verified</span>' : ''}</div>
        <div class="hint">${escapeHtml(c.message || 'No message')}</div>
        ${(c.status === 'accepted' || c.status === 'completed' || c.status === 'not_completed') && c.requester_email ? `<div class="hint">✉️ ${escapeHtml(c.requester_email)}</div>` : ''}
        ${c.status === 'pending' ? `<div class="hint">🔒 Their contact details stay private until you accept.</div><div class="actions">
          <button class="accept" data-id="${c.id}" data-status="accepted">Accept</button>
          <button class="decline" data-id="${c.id}" data-status="declined">Decline</button>
        </div>` : ''}
        ${confirmBlockHtml(c, 'giver', 'claim')}
        ${ratingPromptHtml(c, 'claim', ratedSet)}
      </div>`).join('') : `<div class="empty">No requests received yet.</div>`;
    bindAcceptDeclineButtons(el, '/api/claims', () => { setActivityTab('tabItemsReceived'); loadItems(); });
    bindConfirmBlocks(el, () => { setActivityTab('tabItemsReceived'); loadItems(); loadMonthlyBadges(); });
    bindRatingPrompts(el, () => { setActivityTab('tabItemsReceived'); });
  } else if (tabId === 'tabItemsSent') {
    const claims = await api('/api/my/claims-sent');
    el.innerHTML = claims.length ? claims.map(c => `
      <div class="claim-row">
        <div class="claim-row-head"><strong>${escapeHtml(c.item_title)}</strong>${flowStatusBadgeHtml(c.status, 'sent')}</div>
        <div class="hint">Listing: ${myPostStatusBadgeHtml(c.item_status)}</div>
        ${confirmBlockHtml(c, 'receiver', 'claim')}
        ${ratingPromptHtml(c, 'claim', ratedSet)}
      </div>`).join('') : `<div class="empty">You haven't requested anything yet.</div>`;
    bindConfirmBlocks(el, () => { setActivityTab('tabItemsSent'); loadItems(); loadMonthlyBadges(); });
    bindRatingPrompts(el, () => { setActivityTab('tabItemsSent'); });
  } else if (tabId === 'tabOffersReceived') {
    const offers = await api('/api/my/request-offers-received');
    // Same privacy tiering as claims above: verified badge + message pre-accept, contact/exact
    // pickup only once accepted (server already enforces this — see stripExactPickup).
    el.innerHTML = offers.length ? offers.map(o => `
      <div class="claim-row">
        <div class="claim-row-head"><strong>${escapeHtml(o.request_title)}</strong>${flowStatusBadgeHtml(o.status, 'received')}</div>
        <div class="hint">From <button type="button" class="owner-name-link" data-uid="${escapeHtml(o.responder_id)}">${escapeHtml(o.responder_name)}</button>${o.responder_verified ? ' <span class="verified-badge">✓ Verified</span>' : ''}</div>
        <div class="hint">${escapeHtml(o.message || 'No message')}${o.offered_price ? ' · 💰 Offered ₹' + o.offered_price : ''}</div>
        ${(o.status === 'accepted' || o.status === 'completed') && o.responder_email ? `<div class="hint">✉️ ${escapeHtml(o.responder_email)}</div>` : ''}
        ${o.status === 'pending' ? `<div class="hint">🔒 Their contact details stay private until you accept.</div><div class="actions">
          <button class="accept" data-id="${o.id}" data-status="accepted">Accept</button>
          <button class="decline" data-id="${o.id}" data-status="declined">Decline</button>
        </div>` : ''}
        ${o.pickup_area ? `<div class="hint">📍 ${escapeHtml(o.pickup_area)}</div>` : ''}
        ${exactPickupHtml(o)}
        ${confirmBlockHtml(o, 'receiver', 'offer')}
        ${ratingPromptHtml(o, 'offer', ratedSet)}
      </div>`).join('') : `<div class="empty">No offers received yet.</div>`;
    bindCopyButtons(el);
    bindAcceptDeclineButtons(el, '/api/request-offers', () => { setActivityTab('tabOffersReceived'); loadRequests(); });
    bindConfirmBlocks(el, () => { setActivityTab('tabOffersReceived'); loadRequests(); loadMonthlyBadges(); });
    bindRatingPrompts(el, () => { setActivityTab('tabOffersReceived'); });
  } else {
    const offers = await api('/api/my/request-offers-sent');
    el.innerHTML = offers.length ? offers.map(o => `
      <div class="claim-row">
        <div class="claim-row-head"><strong>${escapeHtml(o.request_title)}</strong>${flowStatusBadgeHtml(o.status, 'sent')}</div>
        <div class="hint">Request: ${myPostRequestStatusBadgeHtml(o.request_status)}</div>
        ${o.pickup_area ? `<div class="hint">📍 ${escapeHtml(o.pickup_area)}</div>` : ''}
        ${confirmBlockHtml(o, 'giver', 'offer')}
        ${ratingPromptHtml(o, 'offer', ratedSet)}
      </div>`).join('') : `<div class="empty">You haven't offered to help with anything yet.</div>`;
    bindConfirmBlocks(el, () => { setActivityTab('tabOffersSent'); loadRequests(); loadMonthlyBadges(); });
    bindRatingPrompts(el, () => { setActivityTab('tabOffersSent'); });
  }
}

init();
