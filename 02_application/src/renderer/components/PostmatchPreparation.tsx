import { useEffect, useRef, useState } from "react";
import type { AppLanguage } from "../../domain/entities/app-settings.js";
import type { PostmatchStatus, RendererMatchesResponse } from "../../shared/ipc/contracts.js";

export function PostmatchPreparation({ language }: { readonly language: AppLanguage }) {
  const [items, setItems] = useState<RendererMatchesResponse["items"]>([]);
  const [selected, setSelected] = useState("");
  const [status, setStatus] = useState<PostmatchStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const mounted = useRef(false);
  const preparing = useRef(false);
  const analysisGeneration = useRef(0);
  const listGeneration = useRef(0);
  const ru = language === "ru";
  async function refresh() {
    const generation = ++listGeneration.current;
    setLoading(true);
    try {
      const result = await window.sc2Assistant?.listMatches();
      if (mounted.current && generation === listGeneration.current && result) {
        const linked = result.items.filter((item) => item.match.replayPath);
        setItems(linked);
        setSelected((previous) => linked.some((item) => item.match.id === previous) ? previous : linked[0]?.match.id ?? "");
      }
    } catch { if (mounted.current && generation === listGeneration.current) setError(ru ? "Не удалось обновить историю. Можно выбрать файл реплея ниже." : "Could not refresh history. You can choose a replay file below."); }
    finally { if (mounted.current && generation === listGeneration.current) setLoading(false); }
  }
  useEffect(() => {
    mounted.current = true; let next: ReturnType<typeof setTimeout> | undefined;
    void refresh();
    async function poll() {
      try { if (!preparing.current) { const generation = analysisGeneration.current; const result = await window.sc2Assistant?.getPostmatchStatus?.(); if (mounted.current && generation === analysisGeneration.current && result) setStatus(result); } }
      catch { if (mounted.current) setError(ru ? "Не удалось проверить анализ матча." : "Could not check match analysis."); }
      finally { if (mounted.current) next = setTimeout(poll, 1500); }
    }
    void poll();
    return () => { mounted.current = false; ++listGeneration.current; clearTimeout(next); };
  }, [language]);
  async function prepare(fromFile: boolean) {
    const bridge = window.sc2Assistant;
    if (preparing.current || (!fromFile && (!selected || !bridge?.preparePostmatch)) || (fromFile && !bridge?.choosePostmatchReplay)) return;
    preparing.current = true; ++analysisGeneration.current; setBusy(true); setError("");
    try {
      const result = fromFile ? await bridge!.choosePostmatchReplay!() : await bridge!.preparePostmatch!({ matchId: selected });
      // Cancelling the native picker preserves the previous analysis and presentation clock.
      if (mounted.current && result) setStatus(result);
    } catch (problem: unknown) { if (mounted.current) setError(problem instanceof Error ? problem.message : String(problem)); }
    finally { preparing.current = false; if (mounted.current) setBusy(false); }
  }
  const disabled = busy || status?.status === "processing";
  const message = status?.status === "ready" ? ru ? "Анализ подготовлен. Виджеты используют один матч и общее время показа." : "Analysis ready. All widgets share one match and presentation clock."
    : status?.status === "processing" ? ru ? "Разбираем реплей…" : "Analyzing replay…" : status?.status === "error" ? status.error ?? (ru ? "Анализ недоступен. Выберите другой реплей или повторите подготовку." : "Analysis unavailable. Choose another replay or try again.") : ru ? "Анализ ещё не подготовлен. Выберите матч из истории или откройте файл реплея." : "Analysis is not prepared yet. Choose a saved match or open a replay file.";
  return <section className="smart-settings" aria-labelledby="postmatch-prepare-title">
    <h4 id="postmatch-prepare-title">{ru ? "Матч для четырёх виджетов" : "Match for all four widgets"}</h4>
    <p className="settings-helper">{ru ? "1×1, 2×2, 3×3, 4×4 и FFA: откройте реплей для просмотра. История соперников содержит только сохранённые матчи 1×1." : "1v1, 2v2, 3v3, 4v4 and FFA: open a replay to view it. Opponent history contains saved 1v1 matches only."}</p>
    <div className="obs-settings-actions"><button type="button" className="ghost-button" disabled={disabled || !window.sc2Assistant?.choosePostmatchReplay} onClick={() => void prepare(true)}>{ru ? "Выбрать реплей…" : "Choose replay…"}</button><button type="button" className="ghost-button" disabled={disabled || loading} onClick={() => void refresh()}>{loading ? ru ? "Обновляем…" : "Refreshing…" : ru ? "Обновить историю" : "Refresh history"}</button></div>
    <div className="obs-settings-connection"><label>{ru ? "Сохранённый матч с реплеем" : "Saved match with a replay"}<select value={selected} disabled={disabled || loading || items.length === 0} onChange={(event) => setSelected(event.currentTarget.value)}><option value="">{items.length === 0 ? ru ? "Нет сохранённых матчей с реплеем" : "No saved matches with a replay" : ru ? "Выберите матч" : "Choose a match"}</option>{items.map(({ match, opponent }) => <option key={match.id} value={match.id}>{new Date(match.playedAt).toLocaleString(ru ? "ru-RU" : "en-US")} · {opponent?.nickname ?? "—"} · {match.map ?? "—"}</option>)}</select></label><button type="button" className="ghost-button" disabled={!selected || disabled || !window.sc2Assistant?.preparePostmatch} onClick={() => void prepare(false)}>{ru ? "Подготовить анализ" : "Prepare analysis"}</button></div>
    <p className="settings-helper" role="status">{message}</p>
    <p className="settings-helper">{ru ? "Нужен современный реплей на скорости «Очень быстро» длиннее двух минут, с данными tracker и минимум двумя командами. Подготовка только читает файл и не добавляет его в историю соперников. В эфире видны только применённые виджеты меню." : "Requires a modern Faster replay longer than two minutes, tracker data and at least two teams. Preparation only reads the file and does not add it to opponent history. Only applied menu widgets appear on stream."}</p>
    {error ? <p role="alert" className="form-status error">{error}</p> : null}
  </section>;
}
