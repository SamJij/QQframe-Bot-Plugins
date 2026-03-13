const {
    getAllPlants,
    getFruitPrice,
    getSeedPrice,
    getItemImageById,
} = require('../config/gameConfig');

function toNum(v) {
    if (v === undefined || v === null || v === '') return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function parseGrowTimeSec(growPhases) {
    if (!growPhases) return 0;
    const phases = String(growPhases).split(';').filter(Boolean);
    let total = 0;
    for (const p of phases) {
        const m = p.match(/:(\d+)$/);
        if (m) total += Number.parseInt(m[1], 10) || 0;
    }
    return total;
}

function formatTime(seconds) {
    const sec = Math.max(0, Math.floor(toNum(seconds)));
    if (sec < 60) return `${sec}秒`;
    if (sec < 3600) return `${Math.floor(sec / 60)}分${sec % 60}秒`;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return m > 0 ? `${h}时${m}分` : `${h}时`;
}

function normalizeSort(sortBy = 'exp') {
    const s = String(sortBy || '').trim().toLowerCase();
    if (s === 'profit' || s === 'level' || s === 'exp') return s;
    return 'exp';
}

/**
 * 计算作物效率排行。
 * sort: exp | profit | level
 */
function getPlantRankings(options = {}) {
    const sortBy = normalizeSort(options.sort);
    const minRequiredLevel = toNum(options.minRequiredLevel);
    const maxRequiredLevel = toNum(options.maxRequiredLevel);
    const availableLevel = toNum(options.availableLevel);
    const availableOnly = options.availableOnly === true;

    const rows = [];
    for (const plant of getAllPlants()) {
        const seedId = toNum(plant && plant.seed_id);
        if (seedId <= 0) continue;

        const baseGrowSec = parseGrowTimeSec(plant.grow_phases);
        if (baseGrowSec <= 0) continue;

        const seasons = Math.max(1, toNum(plant.seasons) || 1);
        const isTwoSeason = seasons === 2;
        const growSec = isTwoSeason ? (baseGrowSec * 1.5) : baseGrowSec;
        const safeGrowSec = growSec > 0 ? growSec : 1;

        const harvestExpBase = toNum(plant.exp);
        const harvestExp = isTwoSeason ? (harvestExpBase * 2) : harvestExpBase;

        const fruitId = toNum(plant && plant.fruit && plant.fruit.id);
        const fruitCount = toNum(plant && plant.fruit && plant.fruit.count);
        const seedPrice = getSeedPrice(seedId);
        const fruitPrice = getFruitPrice(fruitId);
        const income = (fruitCount * fruitPrice) * (isTwoSeason ? 2 : 1);
        const netProfit = income - seedPrice;
        const requiredLevelRaw = toNum(plant.land_level_need);
        const requiredLevel = requiredLevelRaw > 0 ? requiredLevelRaw : null;

        if (minRequiredLevel > 0 && requiredLevel !== null && requiredLevel < minRequiredLevel) continue;
        if (maxRequiredLevel > 0 && requiredLevel !== null && requiredLevel > maxRequiredLevel) continue;
        if (availableOnly && availableLevel > 0 && requiredLevel !== null && requiredLevel > availableLevel) continue;

        rows.push({
            id: toNum(plant.id),
            seedId,
            name: String(plant.name || `种子${seedId}`),
            seasons,
            level: requiredLevel,
            growSec,
            growTime: formatTime(growSec),
            expPerHour: Number(((harvestExp / safeGrowSec) * 3600).toFixed(2)),
            profitPerHour: Number(((netProfit / safeGrowSec) * 3600).toFixed(2)),
            netProfit: Number(netProfit.toFixed(2)),
            income: Number(income.toFixed(2)),
            fruitId,
            fruitCount,
            fruitPrice,
            seedPrice,
            image: getItemImageById(seedId),
        });
    }

    if (sortBy === 'profit') {
        rows.sort((a, b) => b.profitPerHour - a.profitPerHour);
    } else if (sortBy === 'level') {
        rows.sort((a, b) => {
            const lvA = a.level === null ? -1 : a.level;
            const lvB = b.level === null ? -1 : b.level;
            return lvB - lvA;
        });
    } else {
        rows.sort((a, b) => b.expPerHour - a.expPerHour);
    }

    const limit = Math.max(1, Math.min(500, toNum(options.limit) || 100));
    return rows.slice(0, limit);
}

module.exports = {
    getPlantRankings,
};
