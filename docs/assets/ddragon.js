/**
 * ddragon.js — ảnh tướng / item / ngọc từ Data Dragon (CDN công khai của Riot, CORS *).
 *
 * Đã kiểm chứng: `championId` mà feed livestats trả về (KSante, MonkeyKing,
 * JarvanIV, Yunara...) khớp 1:1 với key của Data Dragon, nên KHÔNG cần bảng
 * alias. Nếu sau này Riot lệch, thêm vào CHAMPION_ALIASES là chỗ duy nhất phải sửa.
 */

const DDRAGON = 'https://ddragon.leagueoflegends.com';
const CACHE_KEY = 'esports-hub:ddragon-version';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Chỉ dùng khi Riot đặt tên lệch với Data Dragon. Hiện tại trống. */
const CHAMPION_ALIASES = {};

let versionPromise = null;
let runesPromise = null;

/** Phiên bản Data Dragon mới nhất, cache 24h trong localStorage. */
export function getVersion() {
  if (versionPromise) return versionPromise;

  const cached = readCache();
  if (cached) {
    versionPromise = Promise.resolve(cached);
    return versionPromise;
  }

  versionPromise = fetch(`${DDRAGON}/api/versions.json`)
    .then((r) => r.json())
    .then((versions) => {
      const v = versions[0];
      writeCache(v);
      return v;
    })
    .catch(() => {
      versionPromise = null;
      // Thà dùng phiên bản cũ còn hơn không có ảnh nào.
      return '16.16.1';
    });

  return versionPromise;
}

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { version, at } = JSON.parse(raw);
    return Date.now() - at < CACHE_TTL_MS ? version : null;
  } catch {
    return null;
  }
}

function writeCache(version) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ version, at: Date.now() }));
  } catch {
    /* localStorage bị chặn (private mode) — bỏ qua, chỉ mất cache */
  }
}

/**
 * Tải phiên bản + bảng ngọc một lần, trả về bộ hàm dựng URL đồng bộ để chỗ
 * render không phải rải `await` trong vòng lặp.
 */
export async function loadAssets() {
  const [version, runes] = await Promise.all([getVersion(), getRuneIndex()]);
  return {
    version,
    champion: (championId) => {
      if (!championId) return null;
      const key = CHAMPION_ALIASES[championId] ?? String(championId).replace(/[^A-Za-z0-9]/g, '');
      return `${DDRAGON}/cdn/${version}/img/champion/${key}.png`;
    },
    item: (itemId) => (itemId ? `${DDRAGON}/cdn/${version}/img/item/${itemId}.png` : null), // 0 = ô trống
    rune: (runeId) => runes.get(runeId) ?? null,
    keystone: (perkMetadata) => (perkMetadata?.perks?.length ? runes.get(perkMetadata.perks[0]) ?? null : null),
  };
}

/** Map id ngọc/nhánh -> {name, icon}. Tải một lần, dùng lại. */
export function getRuneIndex() {
  if (runesPromise) return runesPromise;

  runesPromise = getVersion()
    .then((v) => fetch(`${DDRAGON}/cdn/${v}/data/en_US/runesReforged.json`))
    .then((r) => r.json())
    .then((styles) => {
      const index = new Map();
      for (const style of styles) {
        index.set(style.id, { name: style.name, icon: `${DDRAGON}/cdn/img/${style.icon}` });
        for (const slot of style.slots) {
          for (const rune of slot.runes) {
            index.set(rune.id, { name: rune.name, icon: `${DDRAGON}/cdn/img/${rune.icon}` });
          }
        }
      }
      return index;
    })
    .catch(() => new Map());

  return runesPromise;
}
