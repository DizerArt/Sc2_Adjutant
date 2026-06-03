import {
  type ChangeEvent,
  type FormEvent,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { MatchHistoryItem } from "../../application/use-cases/list-match-history.js";
import {
  MAX_OPPONENT_STRATEGY_TAG_LENGTH,
  MAX_OPPONENT_STRATEGY_TAGS,
  OPPONENT_MARKERS,
  type Opponent,
  type OpponentMarker,
} from "../../domain/entities/opponent.js";
import type { Race } from "../../domain/value-objects/race.js";
import protossModelUrl from "../assets/protoss-model.png";
import randomModelUrl from "../assets/random-model.png";
import terranModelUrl from "../assets/terran-model.png";
import zergModelUrl from "../assets/zerg-model.png";
import { createTranslator, type Translator } from "../i18n.js";

const RACE_PORTRAITS: Partial<Record<RaceTheme, string>> = {
  terran: terranModelUrl,
  zerg: zergModelUrl,
  protoss: protossModelUrl,
  random: randomModelUrl,
};

const AGGRESSION_TAG_PATTERNS = [
  "rush",
  "all-in",
  "all in",
  "allin",
  "all-out",
  "all out",
  "allout",
  "cheese",
  "cheesy",
  "early",
  "pressure",
  "proxy",
  "timing",
  "timing attack",
  "push",
  "attack",
  "bust",
  "contain",
  "commit",
  "committed",
  "one base",
  "1 base",
  "1base",
  "two base",
  "2 base",
  "2base",
  "cannon rush",
  "12 pool",
  "pool first",
  "ling flood",
  "bane bust",
  "roach ravager",
  "marine push",
  "marine scv",
  "scv all-in",
  "scv allin",
  "scv pull",
  "scv rush",
  "tank push",
  "tank timing",
  "siege push",
  "siege timing",
  "blink timing",
  "blink all-in",
  "blink allin",
  "blink rush",
  "blink push",
  "adept pressure",
  "glaive adept",
  "glaive push",
  "glaive timing",
  "proxy rax",
  "proxy gate",
  "proxy hatch",
  "proxy stargate",
  "proxy robo",
  "proxy barracks",
  "aggressive",
  "agression",
  "aggress",
  "agro",
  "aggro",
  "agrssive",
  "agressive",
  "kill push",
  "max push",
  "punish",
  "follow up",
  "follow-up",
  "followup",
  "first push",
  "first attack",
  "fast push",
  "fast attack",
  "snipe push",
  "elimination push",
  "reaper rush",
  "reaper push",
  "reaper pressure",
  "reaper all-in",
  "bunker rush",
  "marauder push",
  "marauder rush",
  "marauder timing",
  "stim push",
  "stim timing",
  "stim attack",
  "stim pressure",
  "concussive",
  "hellion rush",
  "hellbat rush",
  "blue flame",
  "thor rush",
  "thor timing",
  "battlecruiser rush",
  "bc rush",
  "4 gate",
  "4gate",
  "four gate",
  "fourgate",
  "3 gate",
  "3gate",
  "three gate",
  "threegate",
  "2 gate",
  "2gate",
  "twogate",
  "stargate rush",
  "stargate all-in",
  "voidray rush",
  "void ray rush",
  "voidray all-in",
  "void ray all-in",
  "immortal all-in",
  "immortal allin",
  "immortal timing",
  "immortal push",
  "immortal sentry",
  "archon all-in",
  "archon allin",
  "archon push",
  "archon timing",
  "zealot rush",
  "zealot all-in",
  "chargelot push",
  "chargelot all-in",
  "chargelot allin",
  "chargelot rush",
  "warpgate push",
  "warp gate push",
  "dt rush",
  "dt all-in",
  "dt allin",
  "dark templar rush",
  "6 pool",
  "6pool",
  "six pool",
  "sixpool",
  "speedling all-in",
  "speedling allin",
  "speedling rush",
  "speedling flood",
  "speedling push",
  "baneling bust",
  "baneling rush",
  "bane rush",
  "bane all-in",
  "bane allin",
  "ling bling bust",
  "ling bling all-in",
  "ling bling push",
  "roach rush",
  "roach push",
  "roach timing",
  "roach max",
  "roach all-in",
  "roach allin",
  "hydra bust",
  "hydra rush",
  "hydra push",
  "hydra timing",
  "ravager bust",
  "ravager rush",
  "ravager push",
  "ravager timing",
  "queen walk",
  "queen push",
  "раш",
  "раши",
  "олл-ин",
  "олл ин",
  "ол-ин",
  "олин",
  "алл-ин",
  "алл ин",
  "чиз",
  "чизит",
  "сыр",
  "ранний пуш",
  "ранняя атака",
  "агрессия",
  "агрессив",
  "давление",
  "прессинг",
  "прокси",
  "тайминг",
  "пуш",
  "атака",
  "баст",
  "контейн",
  "коммит",
  "одна база",
  "1 база",
  "две базы",
  "2 базы",
  "канон раш",
  "бункер раш",
  "12 пул",
  "пул 12",
  "6 пул",
  "линги",
  "бейнлинг",
  "роуч пуш",
  "танк пуш",
  "блинк пуш",
  "пулл рабочих",
];
const ECONOMY_TAG_PATTERNS = [
  "macro",
  "turtle",
  "eco",
  "economy",
  "greedy",
  "greed",
  "expand",
  "expansion",
  "fast expand",
  "fe",
  "third",
  "3rd",
  "fourth",
  "4th",
  "five base",
  "5 base",
  "5base",
  "six base",
  "6 base",
  "6base",
  "long",
  "late",
  "late game",
  "lategame",
  "long game",
  "macro game",
  "macro build",
  "macro play",
  "defensive",
  "defence",
  "defense",
  "passive",
  "camp",
  "camping",
  "turtling",
  "cc first",
  "nexus first",
  "hatch first",
  "drone",
  "worker",
  "saturate",
  "saturated",
  "max army",
  "maxed",
  "max out",
  "200/200",
  "200 supply",
  "200 army",
  "supply max",
  "deathball",
  "death ball",
  "death-ball",
  "boom",
  "booming",
  "eco boom",
  "stable",
  "stable economy",
  "stable eco",
  "safe play",
  "play safe",
  "safe build",
  "stay home",
  "money play",
  "money game",
  "static defense",
  "static defence",
  "static d",
  "wall off",
  "wall-off",
  "walloff",
  "wallin",
  "wall in",
  "production heavy",
  "max production",
  "deep eco",
  "deep economy",
  "tier 3",
  "tier3",
  "t3",
  "tier 2",
  "tier2",
  "t2",
  "skytoss",
  "sky toss",
  "skyterran",
  "sky terran",
  "skyzerg",
  "sky zerg",
  "mech",
  "mech style",
  "mech build",
  "mech comp",
  "mech composition",
  "bio mech",
  "biomech",
  "tank line",
  "siege tank",
  "tank composition",
  "planetary",
  "planetary fortress",
  "spire",
  "lair",
  "hive",
  "hive tech",
  "lair tech",
  "fast hive",
  "fast lair",
  "fast hive tech",
  "fast lair tech",
  "broodlord",
  "brood lord",
  "brood",
  "ultralisk",
  "ultra ling",
  "ultra ling bling",
  "carrier",
  "carriers",
  "fast carrier",
  "tempest",
  "tempests",
  "mothership",
  "spore",
  "spore crawler",
  "spine",
  "spine crawler",
  "missile turret",
  "turret line",
  "turret ring",
  "supply depot wall",
  "depot wall",
  "build order",
  "standard build",
  "standard opening",
  "макро",
  "экономика",
  "эко",
  "жадный",
  "жадность",
  "экспанд",
  "расширение",
  "быстрая база",
  "третья",
  "третья база",
  "четвертая",
  "4 база",
  "долгая игра",
  "лейт",
  "поздняя игра",
  "оборона",
  "деф",
  "дефенс",
  "пассив",
  "черепаха",
  "черепашит",
  "сидит дома",
  "стенка",
  "застройка",
  "мех",
  "скайтосс",
  "скай терран",
  "носители",
  "броды",
  "ультра",
  "шпиль",
  "хайв",
  "улей",
  "стандарт",
  "бо",
  "билд ордер",
  "200 лимит",
  "максится",
  "макромонстр",
];
const UNPREDICTABLE_TAG_PATTERNS = [
  "mix",
  "switch",
  "tech",
  "hidden",
  "hidden tech",
  "off-meta",
  "off meta",
  "tricky",
  "sneaky",
  "weird",
  "harass",
  "harassment",
  "harasses",
  "drop",
  "drop play",
  "doom drop",
  "multiprong",
  "multi-prong",
  "multi prong",
  "multipronged",
  "runby",
  "run-by",
  "run by",
  "ling runby",
  "zergling runby",
  "speedling runby",
  "hellion runby",
  "air",
  "cloak",
  "cloaked",
  "dt",
  "dark templar",
  "oracle",
  "warp prism",
  "warp prism drop",
  "warp prism harass",
  "prism drop",
  "nydus",
  "nydus worm",
  "burrow",
  "burrowed",
  "mutalisk",
  "muta",
  "muta harass",
  "mutalisk harass",
  "liberator",
  "liberator drop",
  "battlecruiser",
  "bc",
  "mine drop",
  "widow mine",
  "widow mine drop",
  "proxy starport",
  "banshee",
  "banshees",
  "cloaked banshee",
  "banshee harass",
  "ghost",
  "ghost snipe",
  "ghost harass",
  "nuke",
  "nukes",
  "nuked",
  "nuclear",
  "raven",
  "auto turret",
  "auto turret drop",
  "pdd",
  "medivac",
  "medivac drop",
  "medivac harass",
  "viking drop",
  "hellion drop",
  "hellion harass",
  "reaper harass",
  "reaper scout",
  "phoenix",
  "phoenixes",
  "phoenix harass",
  "phoenix lift",
  "shade",
  "shading",
  "adept shade",
  "stalker drop",
  "lurker",
  "lurkers",
  "lurker drop",
  "lurker bust",
  "infestor",
  "fungal",
  "neural",
  "neural parasite",
  "infested",
  "infested terran",
  "viper",
  "abduct",
  "abduction",
  "blinding cloud",
  "creep drop",
  "elevator",
  "elevator drop",
  "denial",
  "deny",
  "denying",
  "deny expansion",
  "deny base",
  "fake",
  "fake expand",
  "fake all-in",
  "fake allin",
  "feint",
  "bait",
  "baiting",
  "baited",
  "mind game",
  "mindgame",
  "mind games",
  "transition",
  "tech switch",
  "tech transition",
  "split map",
  "spread out",
  "outplay",
  "outplays",
  "trick",
  "trickery",
  "tricks",
  "flying base",
  "flyover",
  "lift off",
  "lift-off",
  "liftoff",
  "микс",
  "свитч",
  "тех",
  "скрытый тех",
  "скрытая теха",
  "нестандарт",
  "не мета",
  "оффмета",
  "странный",
  "хитрый",
  "харас",
  "харасс",
  "дроп",
  "мультипронг",
  "забег",
  "рунбай",
  "линги забег",
  "воздух",
  "инвиз",
  "клок",
  "оракул",
  "призма",
  "нидус",
  "закопка",
  "муты",
  "мута",
  "либератор",
  "бк",
  "мины",
  "банши",
  "гост",
  "нюк",
  "ядерка",
  "рейвен",
  "медивак",
  "феникс",
  "люркер",
  "инфестор",
  "грибок",
  "нейрал",
  "вайпер",
  "похищение",
  "фейк",
  "обман",
  "майндгейм",
  "переход",
  "смена теха",
  "сплит карты",
  "трюк",
  "подстава",
  "лифт",
  "летящая база",
  "рандом",
  "рандомный",
  "непонятный",
  "странный",
];

export type RaceTheme = "terran" | "zerg" | "protoss" | "random";

export type OpponentRaceProfileProps = {
  readonly opponent: Opponent;
  readonly latestMatch: MatchHistoryItem | undefined;
  readonly matches: readonly MatchHistoryItem[];
  readonly onAddInfoClick: (race: Race) => void;
  readonly onHistoryMatchSelect: (item: MatchHistoryItem) => void | Promise<void>;
  readonly onMarkerToggle: (marker: OpponentMarker) => void | Promise<void>;
  readonly onOpenNotesClick: (race: Race) => void;
  readonly onPreviewVoiceClick?: (data: {
    readonly nickname: string;
    readonly race: Race;
    readonly mmr?: number;
    readonly encounters: number;
    readonly wins: number;
    readonly losses: number;
    readonly strategyTags: readonly string[];
    readonly notes: readonly string[];
  }) => void | Promise<void>;
  readonly onStrategyTagAdd: (
    race: Race,
    currentTags: readonly string[],
    tag: string,
  ) => void | Promise<void>;
  readonly onStrategyTagRemove: (
    race: Race,
    currentTags: readonly string[],
    tagIndex: number,
  ) => void | Promise<void>;
  readonly t?: Translator;
};

type PlaystyleScore = {
  readonly aggression: number;
  readonly economy: number;
  readonly unpredictable: number;
};

type RaceStats = {
  readonly encounters: number;
  readonly wins: number;
  readonly losses: number;
  readonly lastMatchDate?: string;
};

type VisibleRaceProfile = {
  readonly mmrAtLastMatch?: number;
  readonly league?: string;
  readonly totalGamesAtLastMatch?: number;
  readonly strategyTags: readonly string[];
  readonly notes: readonly string[];
  readonly confidenceScore?: number;
};

const RACE_TABS: readonly Race[] = ["Terran", "Protoss", "Zerg", "Random"];
const TAG_INPUT_FALLBACK_WIDTH_PX = 102;
const TAG_INPUT_EDGE_PADDING_PX = 2;
const OPPONENT_HISTORY_PAGE_SIZE = 5;

let tagMeasureCanvas: HTMLCanvasElement | undefined;

const OPPONENT_MARKER_SYMBOLS: Record<OpponentMarker, string> = {
  skull: "☠",
  heart: "♥",
  blocked: "⊘",
};

export function OpponentRaceProfile({
  opponent,
  latestMatch,
  matches,
  onAddInfoClick,
  onHistoryMatchSelect,
  onMarkerToggle,
  onOpenNotesClick,
  onPreviewVoiceClick,
  onStrategyTagAdd,
  onStrategyTagRemove,
  t = createTranslator("en"),
}: OpponentRaceProfileProps) {
  const initialRace = visibleRace(
    latestMatch?.match.opponentRace ?? opponent.race,
  );
  const [selectedRace, setSelectedRace] = useState<Race>(initialRace);

  useEffect(() => {
    setSelectedRace(initialRace);
  }, [initialRace, opponent.id]);

  const raceStats = useMemo(
    () => opponentRaceStats(opponent, matches, selectedRace),
    [matches, opponent, selectedRace],
  );
  const opponentHistory = useMemo(
    () => opponentMatches(opponent, matches),
    [matches, opponent],
  );
  const visibleProfile = visibleRaceProfile(opponent, selectedRace, raceStats);
  const theme = raceThemeFor(selectedRace);
  const playstyle = playstyleFromTags(visibleProfile.strategyTags);
  const winRate = winRateFor(raceStats, t);
  const mmrLabel = formatMmr(visibleProfile.mmrAtLastMatch, t);
  const totalGamesLabel = formatTotalGames(
    visibleProfile.totalGamesAtLastMatch,
    t,
  );
  const visibleTags = visibleProfile.strategyTags.slice(
    0,
    MAX_OPPONENT_STRATEGY_TAGS,
  );
  const hiddenTagCount = Math.max(
    0,
    visibleProfile.strategyTags.length - visibleTags.length,
  );
  const [isAddingTag, setIsAddingTag] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  const [isSavingTag, setIsSavingTag] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [historyPage, setHistoryPage] = useState(0);
  const canAddTag =
    visibleProfile.strategyTags.length < MAX_OPPONENT_STRATEGY_TAGS;
  const historyPageCount = Math.max(
    1,
    Math.ceil(opponentHistory.length / OPPONENT_HISTORY_PAGE_SIZE),
  );
  const visibleHistory = opponentHistory.slice(
    historyPage * OPPONENT_HISTORY_PAGE_SIZE,
    historyPage * OPPONENT_HISTORY_PAGE_SIZE + OPPONENT_HISTORY_PAGE_SIZE,
  );

  useEffect(() => {
    setIsAddingTag(false);
    setTagDraft("");
    setIsSavingTag(false);
    setIsHistoryOpen(false);
    setHistoryPage(0);
  }, [opponent.id, selectedRace]);

  useEffect(() => {
    setHistoryPage((currentPage) =>
      Math.min(currentPage, historyPageCount - 1),
    );
  }, [historyPageCount]);

  async function submitStrategyTag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const tagInput = event.currentTarget.elements.namedItem("strategy-tag");
    const fittedTag =
      tagInput instanceof HTMLInputElement
        ? fitTagDraftToInput(tagDraft, tagInput)
        : tagDraft.slice(0, MAX_OPPONENT_STRATEGY_TAG_LENGTH);
    const normalizedTag = fittedTag.trim();
    if (!normalizedTag || !canAddTag || isSavingTag) {
      return;
    }

    setIsSavingTag(true);
    try {
      await onStrategyTagAdd(
        selectedRace,
        visibleProfile.strategyTags,
        normalizedTag,
      );
      setTagDraft("");
      setIsAddingTag(false);
    } catch {
      // Keep the inline editor open so the user can retry.
    } finally {
      setIsSavingTag(false);
    }
  }

  function updateTagDraft(event: ChangeEvent<HTMLInputElement>) {
    setTagDraft(
      fitTagDraftToInput(event.currentTarget.value, event.currentTarget),
    );
  }

  async function removeStrategyTag(tagIndex: number) {
    if (isSavingTag) {
      return;
    }

    setIsSavingTag(true);
    try {
      await onStrategyTagRemove(
        selectedRace,
        visibleProfile.strategyTags,
        tagIndex,
      );
    } catch {
      // Leave current UI intact if persistence fails.
    } finally {
      setIsSavingTag(false);
    }
  }

  return (
    <article className={`race-profile theme-${theme}`} data-race={theme}>
      <aside className="race-profile-left">
        <header className="panel-title">{t("profile.race")}</header>
        <div className="race-stage-meta" aria-hidden="true">
          <span>{databaseLabel(selectedRace)}</span>
          <span>//ID: {opponentDatabaseId(opponent.id)}</span>
          <span>
            //STATUS: {raceStats.encounters > 0 ? "ACTIVE" : "STANDBY"}
          </span>
        </div>
        <div className="race-stage">
          <div className="race-stage-frame" aria-hidden="true" />
          {RACE_PORTRAITS[theme] ? (
            <img
              className="race-stage-portrait"
              src={RACE_PORTRAITS[theme]}
              alt=""
              aria-hidden="true"
            />
          ) : (
            <div className={`race-emblem race-${theme}`} aria-hidden="true">
              <span className="emblem-ring" />
              <span className={emblemShapeClass(theme)} />
            </div>
          )}
        </div>
        <footer className="race-label">
          <span className="race-label-glyph" aria-hidden="true" />
          <span className="race-label-text">{selectedRace}</span>
          <span className="race-label-glyph" aria-hidden="true" />
        </footer>
      </aside>

      <section className="race-profile-right">
        <div className="opponent-title-row">
          <div className="opponent-title-main">
            <header className="panel-title">{t("profile.opponent")}</header>
            {onPreviewVoiceClick ? (
              <button
                aria-label={t("profile.previewVoice")}
                className="profile-voice-preview-button"
                onClick={() =>
                  void onPreviewVoiceClick({
                    nickname: formatOpponentDisplayName(opponent),
                    race: selectedRace,
                    mmr: visibleProfile.mmrAtLastMatch,
                    encounters: raceStats.encounters,
                    wins: raceStats.wins,
                    losses: raceStats.losses,
                    strategyTags: visibleProfile.strategyTags,
                    notes: visibleProfile.notes,
                  })
                }
                title={t("profile.previewVoice")}
                type="button"
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    d="M2 6.2h2.7L8.6 3v10L4.7 9.8H2z"
                    fill="currentColor"
                  />
                  <path
                    d="M10.2 5.4c.8.8.8 4.4 0 5.2M12.2 3.8c1.8 1.8 1.8 6.6 0 8.4"
                    fill="none"
                    stroke="currentColor"
                    strokeLinecap="round"
                    strokeWidth="1.4"
                  />
                </svg>
              </button>
            ) : null}
          </div>
          <div
            className="profile-marker-controls"
            aria-label={t("profile.markers")}
          >
            {OPPONENT_MARKERS.map((marker) => (
              <button
                aria-label={opponentMarkerLabel(marker, t)}
                data-active={
                  (opponent.markers ?? []).includes(marker) ? "true" : "false"
                }
                data-marker={marker}
                key={marker}
                onClick={() => void onMarkerToggle(marker)}
                title={opponentMarkerLabel(marker, t)}
                type="button"
            >
                {OPPONENT_MARKER_SYMBOLS[marker]}
              </button>
            ))}
          </div>
        </div>
        <div className="profile-identity">
          <h3 className="identity-name">
            {formatOpponentDisplayName(opponent)}
          </h3>
          <div
            className="race-tabs"
            role="tablist"
            aria-label={t("profile.opponentAria")}
          >
            {RACE_TABS.map((race) => (
              <button
                aria-selected={race === selectedRace}
                className="race-tab"
                data-active={race === selectedRace ? "true" : "false"}
                key={race}
                onClick={() => setSelectedRace(race)}
                role="tab"
                type="button"
              >
                {race.slice(0, 1)}
              </button>
            ))}
          </div>
          {opponent.battleTag ? (
            <p className="identity-battletag">
              <span>{t("profile.battleTag")}</span>
              <strong>{opponent.battleTag}</strong>
            </p>
          ) : null}
          <p className="identity-mmr">
            <span
              className="identity-icon"
              data-icon="mmr"
              aria-hidden="true"
            />
            <span className="identity-mmr-label">{t("profile.mmr")} </span>
            <strong>{mmrLabel}</strong>
            {typeof visibleProfile.totalGamesAtLastMatch === "number" ? (
              <span className="identity-total-games">
                <span>{t("profile.totalGames")}</span>
                <strong>{totalGamesLabel}</strong>
              </span>
            ) : null}
            {visibleProfile.league ? (
              <small>
                <span className="identity-league-label">
                  {t("profile.league")}
                </span>
                {visibleProfile.league}
              </small>
            ) : null}
          </p>
        </div>

        <button
          className="profile-notes-button"
          onClick={() => onOpenNotesClick(selectedRace)}
          type="button"
        >
          <span>{t("profile.notes")}</span>
          {visibleProfile.notes.length > 0 ? (
            <strong>{visibleProfile.notes.length}</strong>
          ) : null}
        </button>
        <button
          className="profile-history-button"
          data-active={isHistoryOpen ? "true" : "false"}
          onClick={() => setIsHistoryOpen((current) => !current)}
          type="button"
        >
          <span>{t("profile.matchHistory")}</span>
          <strong>{opponentHistory.length}</strong>
        </button>
        {isHistoryOpen ? (
          <section className="profile-history-popover">
            <header>
              <span>{t("profile.matchHistory")}</span>
              <strong>{opponentHistory.length}</strong>
            </header>
            {visibleHistory.length > 0 ? (
              <ul role="list">
                {visibleHistory.map((item) => (
                  <li data-result={item.match.result} key={item.match.id}>
                    <button
                      className="profile-history-row"
                      onClick={() => void onHistoryMatchSelect(item)}
                      type="button"
                    >
                      <span className={`history-race race-${raceThemeFor(item.match.opponentRace)}`}>
                        {item.match.opponentRace.slice(0, 1)}
                      </span>
                      <div>
                        <strong>{matchResultLabel(item.match.result)}</strong>
                        <small>
                          {formatHistoryDate(item.match.playedAt)}
                          {" / "}
                          {item.match.durationSeconds
                            ? formatHistoryDuration(item.match.durationSeconds)
                            : "--"}
                        </small>
                        {item.match.map ? <em title={item.match.map}>{item.match.map}</em> : null}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p>{t("profile.noMatchHistory")}</p>
            )}
            <footer>
              <button
                disabled={historyPage <= 0}
                onClick={() => setHistoryPage((page) => Math.max(0, page - 1))}
                type="button"
              >
                {t("list.prev")}
              </button>
              <span>
                {t("list.page")} {historyPage + 1} / {historyPageCount}
              </span>
              <button
                disabled={historyPage >= historyPageCount - 1}
                onClick={() =>
                  setHistoryPage((page) =>
                    Math.min(historyPageCount - 1, page + 1),
                  )
                }
                type="button"
              >
                {t("list.next")}
              </button>
            </footer>
          </section>
        ) : null}

        <div className="profile-stat-cards">
          <article className="stat-card encounters">
            <span
              className="stat-icon"
              data-icon="encounters"
              aria-hidden="true"
            />
            <span className="stat-label">{t("profile.encounters")}</span>
            <span className="stat-value">{raceStats.encounters}</span>
          </article>
          <article className="stat-card wins">
            <span className="stat-icon" data-icon="wins" aria-hidden="true" />
            <span className="stat-label">{t("profile.wins")}</span>
            <span className="stat-value">{raceStats.wins}</span>
          </article>
          <article className="stat-card losses">
            <span className="stat-icon" data-icon="losses" aria-hidden="true" />
            <span className="stat-label">{t("profile.losses")}</span>
            <span className="stat-value">{raceStats.losses}</span>
          </article>
        </div>

        <section className="playstyle-analysis">
          <header className="analysis-title">{t("profile.playstyle")}</header>
          <p className="analysis-hint">{t("profile.estimatedHint")}</p>

          <PlaystyleBar
            label={t("profile.aggression")}
            value={playstyle.aggression}
            variant="aggression"
            t={t}
          />
          <PlaystyleBar
            label={t("profile.economy")}
            value={playstyle.economy}
            variant="economy"
            t={t}
          />
          <PlaystyleBar
            label={t("profile.unpredictable")}
            value={playstyle.unpredictable}
            variant="unpredictable"
            t={t}
          />
        </section>

        <section
          className="profile-tags"
          data-has-tags={
            visibleProfile.strategyTags.length > 0 ? "true" : "false"
          }
        >
          <div className="tags-heading">
            <span className="section-label">
              <span
                className="identity-icon"
                data-icon="tags"
                aria-hidden="true"
              />
              {t("profile.tags")}
            </span>
            <button
              aria-label={t("profile.addTag")}
              className="tag-add-toggle"
              disabled={!canAddTag}
              onClick={() => setIsAddingTag(true)}
              title={t("profile.addTag")}
              type="button"
            >
              +
            </button>
            <span className="tag-limit-counter">
              {visibleProfile.strategyTags.length}/{MAX_OPPONENT_STRATEGY_TAGS}
            </span>
          </div>
          {visibleProfile.strategyTags.length > 0 || (isAddingTag && canAddTag) ? (
            <ul className="tags-row" role="list">
              {visibleTags.map((tag, index) => (
                <li
                  className="tag-chip"
                  data-race={theme}
                  key={`${tag}-${index}`}
                  title={tag}
                >
                  <span>{formatTagLabel(tag)}</span>
                  <button
                    aria-label={`Remove ${tag}`}
                    disabled={isSavingTag}
                    onClick={() => void removeStrategyTag(index)}
                    type="button"
                  >
                    x
                  </button>
                </li>
              ))}
              {hiddenTagCount > 0 ? (
                <li className="tag-chip tag-chip-overflow" data-race={theme}>
                  +{hiddenTagCount}
                </li>
              ) : null}
              {isAddingTag && canAddTag ? (
                <li className="tag-add-item">
                  <form className="tag-add-form" onSubmit={submitStrategyTag}>
                    <input
                      aria-label={t("profile.addTag")}
                      autoFocus
                      maxLength={MAX_OPPONENT_STRATEGY_TAG_LENGTH}
                      name="strategy-tag"
                      onChange={updateTagDraft}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          setTagDraft("");
                          setIsAddingTag(false);
                        }
                      }}
                      placeholder={t("profile.addTagPlaceholder")}
                      value={tagDraft}
                    />
                    <button
                      disabled={!tagDraft.trim() || isSavingTag}
                      type="submit"
                    >
                      +
                    </button>
                  </form>
                </li>
              ) : null}
            </ul>
          ) : (
            <p className="tags-empty">{t("profile.noTags")}</p>
          )}
        </section>

        <section className="profile-meta">
          <div>
            <span>{t("profile.winRate")}</span>
            <strong>{winRate}</strong>
          </div>
          <div>
            <span>{t("profile.lastMatch")}</span>
            <strong>{lastMatchLabel(raceStats.lastMatchDate, t)}</strong>
          </div>
          <div>
            <span>{t("profile.confidence")}</span>
            <strong>
              {formatConfidence(visibleProfile.confidenceScore, t)}
            </strong>
          </div>
        </section>

        <footer className="profile-actions">
          <button
            className="primary-button"
            onClick={() => onAddInfoClick(selectedRace)}
            type="button"
          >
            {t("profile.addInfo")}
          </button>
        </footer>
      </section>
    </article>
  );
}

function opponentMarkerLabel(marker: OpponentMarker, t: Translator): string {
  if (marker === "skull") {
    return t("opponentMarker.skull");
  }
  if (marker === "heart") {
    return t("opponentMarker.heart");
  }
  return t("opponentMarker.blocked");
}

function visibleRaceProfile(
  opponent: Opponent,
  race: Race,
  stats: RaceStats,
): VisibleRaceProfile {
  const raceProfile = opponent.raceProfiles?.[race];
  if (raceProfile) {
    return {
      mmrAtLastMatch: raceProfile.mmrAtLastMatch,
      league: raceProfile.league,
      totalGamesAtLastMatch: raceProfile.totalGamesAtLastMatch,
      strategyTags: raceProfile.strategyTags ?? [],
      notes: raceProfile.notes ?? (race === opponent.race ? opponent.notes : []),
      confidenceScore: raceProfile.confidenceScore,
    };
  }

  if (race === opponent.race && stats.encounters > 0) {
    return {
      mmrAtLastMatch: opponent.mmrAtLastMatch,
      league: opponent.league,
      strategyTags: opponent.strategyTags,
      notes: opponent.notes,
      confidenceScore: opponent.confidenceScore,
    };
  }

  return {
    strategyTags: [],
    notes: [],
  };
}

function visibleRace(race: Race): Race {
  return race === "Unknown" ? "Random" : race;
}

function PlaystyleBar({
  label,
  t,
  value,
  variant,
}: {
  readonly label: string;
  readonly t: Translator;
  readonly value: number;
  readonly variant: "aggression" | "economy" | "unpredictable";
}) {
  const ratingLabel = ratingLabelFor(value, t);

  return (
    <div className="bar-row">
      <span className="bar-label">{label}</span>
      <div
        className="progress-track"
        aria-label={`${label} ${Math.round(value * 100)} percent`}
      >
        <span
          className={`progress-fill ${variant}`}
          style={{ width: `${Math.round(value * 100)}%` }}
        />
      </div>
      <span className="bar-rating">{ratingLabel}</span>
    </div>
  );
}

export function formatOpponentDisplayName(opponent: {
  readonly nickname: string;
  readonly revealedNickname?: string;
}): string {
  const revealed = opponent.revealedNickname?.trim();
  return revealed && revealed !== opponent.nickname
    ? `${opponent.nickname} (${revealed})`
    : opponent.nickname;
}

export function raceThemeFor(race: Race): RaceTheme {
  if (race === "Terran") return "terran";
  if (race === "Zerg") return "zerg";
  if (race === "Protoss") return "protoss";
  return "random";
}

export function playstyleFromTags(
  strategyTags: readonly string[],
): PlaystyleScore {
  if (strategyTags.length === 0) {
    return { aggression: 0, economy: 0, unpredictable: 0 };
  }

  const normalizedTags = strategyTags.map((tag) => tag.toLowerCase());
  const aggressionHits = countMatches(normalizedTags, AGGRESSION_TAG_PATTERNS);
  const economyHits = countMatches(normalizedTags, ECONOMY_TAG_PATTERNS);
  const unpredictableHits = countMatches(
    normalizedTags,
    UNPREDICTABLE_TAG_PATTERNS,
  );
  const recognizedHits = aggressionHits + economyHits + unpredictableHits;

  if (recognizedHits === 0) {
    return { aggression: 0, economy: 0, unpredictable: 0 };
  }

  return {
    aggression: clampUnit(aggressionHits / recognizedHits),
    economy: clampUnit(economyHits / recognizedHits),
    unpredictable: clampUnit(unpredictableHits / recognizedHits),
  };
}

function emblemShapeClass(theme: RaceTheme): string {
  if (theme === "terran") return "terran-star";
  if (theme === "zerg") return "zerg-sigil";
  if (theme === "protoss") return "protoss-crystal";
  return "random-mark";
}

function ratingLabelFor(value: number, t: Translator): string {
  if (value >= 0.66) return t("profile.high");
  if (value >= 0.33) return t("profile.med");
  return t("profile.low");
}

function countMatches(
  tags: readonly string[],
  patterns: readonly string[],
): number {
  const compactPatterns = patterns.map(compactPlaystylePattern);

  return tags.reduce(
    (count, tag) =>
      compactPatterns.some((pattern) => tag.includes(pattern))
        ? count + 1
        : count,
    0,
  );
}

function compactPlaystylePattern(pattern: string): string {
  return pattern.trim().slice(0, MAX_OPPONENT_STRATEGY_TAG_LENGTH);
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}

function opponentRaceStats(
  opponent: Opponent,
  matches: readonly MatchHistoryItem[],
  race: Race,
): RaceStats {
  const raceMatches = matches
    .filter(
      (item) =>
        item.match.opponentId === opponent.id &&
        item.match.opponentRace === race,
    )
    .sort((first, second) =>
      second.match.playedAt.localeCompare(first.match.playedAt),
    );

  if (raceMatches.length === 0) {
    return { encounters: 0, wins: 0, losses: 0 };
  }

  return {
    encounters: raceMatches.length,
    wins: raceMatches.filter((item) => item.match.result === "win").length,
    losses: raceMatches.filter((item) => item.match.result === "loss").length,
    lastMatchDate: raceMatches[0]?.match.playedAt,
  };
}

function opponentMatches(
  opponent: Opponent,
  matches: readonly MatchHistoryItem[],
): readonly MatchHistoryItem[] {
  return matches
    .filter((item) => item.match.opponentId === opponent.id)
    .sort((first, second) =>
      second.match.playedAt.localeCompare(first.match.playedAt),
    );
}

function matchResultLabel(result: MatchHistoryItem["match"]["result"]): string {
  if (result === "win") {
    return "WIN";
  }
  if (result === "loss") {
    return "LOSS";
  }
  return "UNK";
}

function formatHistoryDate(playedAt: string): string {
  const date = new Date(playedAt);
  if (Number.isNaN(date.getTime())) {
    return playedAt.slice(0, 10);
  }

  return date.toLocaleDateString(undefined, {
    month: "2-digit",
    day: "2-digit",
    year: "2-digit",
  });
}

function formatHistoryDuration(durationSeconds: number): string {
  const minutes = Math.floor(durationSeconds / 60);
  const seconds = Math.floor(durationSeconds % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function winRateFor(stats: RaceStats, t: Translator): string {
  const total = stats.wins + stats.losses;
  if (total === 0) {
    return t("profile.noRecord");
  }

  return `${Math.round((stats.wins / total) * 100)}%`;
}

function formatConfidence(
  confidenceScore: number | undefined,
  t: Translator,
): string {
  if (typeof confidenceScore !== "number") return t("profile.unknown");
  return `${Math.round(confidenceScore * 100)}%`;
}

function formatMmr(value: number | undefined, t: Translator): string {
  if (typeof value !== "number") return t("profile.unknown");
  return value.toLocaleString("en-US");
}

function formatTotalGames(value: number | undefined, t: Translator): string {
  if (typeof value !== "number") return t("profile.unknown");
  return value.toLocaleString("en-US");
}

function formatTagLabel(tag: string): string {
  const normalized = tag.trim().slice(0, MAX_OPPONENT_STRATEGY_TAG_LENGTH);
  return normalized.toUpperCase();
}

function fitTagDraftToInput(value: string, input: HTMLInputElement): string {
  const nextValue = value.slice(0, MAX_OPPONENT_STRATEGY_TAG_LENGTH);
  const styles = window.getComputedStyle(input);
  const font = [
    styles.fontStyle,
    styles.fontVariant,
    styles.fontWeight,
    styles.fontSize,
    styles.fontFamily,
  ].join(" ");
  const letterSpacing = Number.parseFloat(styles.letterSpacing);
  const spacing = Number.isFinite(letterSpacing) ? letterSpacing : 0;
  const inputWidth =
    input.clientWidth > 0 ? input.clientWidth : TAG_INPUT_FALLBACK_WIDTH_PX;
  const maxWidth = Math.max(1, inputWidth - TAG_INPUT_EDGE_PADDING_PX);

  let fittedValue = nextValue;
  while (
    fittedValue.length > 0 &&
    measureTagTextWidth(fittedValue.toUpperCase(), font, spacing) > maxWidth
  ) {
    fittedValue = fittedValue.slice(0, -1);
  }

  return fittedValue;
}

function measureTagTextWidth(
  text: string,
  font: string,
  letterSpacing: number,
): number {
  tagMeasureCanvas ??= document.createElement("canvas");
  const context = tagMeasureCanvas.getContext("2d");
  if (!context) {
    return text.length * 8;
  }

  context.font = font;
  return (
    context.measureText(text).width +
    Math.max(0, text.length - 1) * letterSpacing
  );
}

function lastMatchLabel(playedAt: string | undefined, t: Translator): string {
  if (!playedAt) {
    return t("profile.noGames");
  }

  return playedAt.slice(0, 10);
}

function databaseLabel(race: Race): string {
  return `${race.toUpperCase()} MULTI-PLY DATABASE`;
}

function opponentDatabaseId(opponentId: string): string {
  // Build a stable, short alphanumeric tag from the opponent id, mimicking the
  // mockup's "//ID: 7431-22" decoration without exposing the raw id.
  let hash = 0;
  for (let index = 0; index < opponentId.length; index += 1) {
    hash = (hash * 31 + opponentId.charCodeAt(index)) % 0xfffff;
  }
  const head = (hash % 10000).toString().padStart(4, "0");
  const tail = ((hash >> 4) % 100).toString().padStart(2, "0");
  return `${head}-${tail}`;
}
