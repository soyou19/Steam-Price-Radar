/**
 * 数据源 3：GamerPower 限免聚合（第三方）。
 *
 * 为什么需要第三方来源：
 *   Steam 官方没有任何公开接口能列出"限时免费"（已实测确认），
 *   而 GamerPower 提供了覆盖 Steam 的限免/激活码列表，可作为补充发现渠道。
 *
 * ⚠️ 外部数据一律视为**不可信输入**：所有字段都会做长度限制与 URL 协议校验，
 *    仅作为展示信息，绝不参与任何命令执行或文件操作。
 */
import { FREE_TYPE, KIND, SOURCE } from '../model.js';
import { clampString, safeUrl, stripTags } from '../util.js';

/** 该来源是完整列表，因此是"权威"的：本轮未出现的条目会在数轮后判定过期。 */
export class GamerPowerSource {
  constructor({ http, store, config, logger }) {
    this.http = http;
    this.store = store;
    this.config = config;
    this.logger = logger;
    this.name = SOURCE.GAMERPOWER;
  }

  static classify(title = '', description = '') {
    const text = `${title} ${description}`.toLowerCase();
    if (/\bdlc\b|expansion|season pass|add-?on/.test(text)) return KIND.DLC;
    return KIND.GAME;
  }

  /** 从任意文本里提取 Steam appid（部分条目会直接给出商店链接）。 */
  static extractAppId(...texts) {
    for (const text of texts) {
      const m = String(text ?? '').match(/store\.steampowered\.com\/app\/(\d+)/i);
      if (m) return Number.parseInt(m[1], 10);
    }
    return null;
  }

  #normalize(raw) {
    const id = raw?.id;
    if (id == null) return null;
    const title = clampString(stripTags(raw.title) || '未命名限免', 200);
    const description = clampString(stripTags(raw.description), 1000) || null;
    const instructions = clampString(stripTags(raw.instructions), 1500) || null;

    // 外部 URL 必须通过协议校验
    const detailUrl = safeUrl(raw.gamerpower_url);
    const openUrl = safeUrl(raw.open_giveaway_url);
    const imageUrl = safeUrl(raw.image) ?? safeUrl(raw.thumbnail);

    const platforms = String(raw.platforms ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    const endDate = raw.end_date && /^\d{4}-\d{2}-\d{2}/.test(raw.end_date)
      ? new Date(raw.end_date.replace(' ', 'T')).toISOString()
      : null;
    const publishedDate = raw.published_date && /^\d{4}-\d{2}-\d{2}/.test(raw.published_date)
      ? new Date(raw.published_date.replace(' ', 'T')).toISOString()
      : null;

    const appId = GamerPowerSource.extractAppId(openUrl?.href, detailUrl?.href, raw.instructions, raw.description);

    return {
      source: SOURCE.GAMERPOWER,
      sourceId: String(id),
      appId,
      kind: GamerPowerSource.classify(title, description ?? ''),
      freeType: FREE_TYPE.KEY,
      title,
      url: (detailUrl ?? openUrl)?.href ?? null,
      image: imageUrl?.href ?? null,
      description,
      instructions,
      requirements: raw.requirements ? clampString(stripTags(raw.requirements), 800) : null,
      worth: raw.worth ? clampString(stripTags(raw.worth), 40) : null,
      platforms,
      publishedDate,
      endDate,
      isFree: true,
      active: !/expired/i.test(String(raw.status ?? 'active')),
    };
  }

  async runOnce() {
    const payload = await this.http.json(this.config.gamerpower.url);
    if (!Array.isArray(payload)) throw new Error('unexpected payload shape');

    const pass = this.store.beginPass(this.name);
    let count = 0;
    let changes = 0;

    for (const raw of payload) {
      const item = this.#normalize(raw);
      if (!item) continue;
      const { event } = this.store.upsert(item);
      pass.seen.add(`${SOURCE.GAMERPOWER}:${item.sourceId}`);
      count += 1;
      if (event) changes += 1;
    }

    const { ended } = this.store.endPass(pass, { tolerance: 2, authoritative: this.authoritative });

    return { count, changes, ended, seenKeys: pass.seen, listComplete: true };
  }

  /** 完整列表来源：本轮未出现 => 已结束。 */
  get authoritative() {
    return true;
  }
}
