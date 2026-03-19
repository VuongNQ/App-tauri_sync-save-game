import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";

import {
  addManualGame,
  loadDashboard,
  refreshDashboard,
  updateGameSavePath,
} from "./services/tauri";
import type { AddGamePayload, DashboardData } from "./types/dashboard";
import "./App.css";

const DEFAULT_ADD_FORM: AddGamePayload = { name: "", launcher: null, installPath: null };

function App() {
  const hasLoadedRef = useRef(false);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null);
  const [savePathDraft, setSavePathDraft] = useState("");
  const [addForm, setAddForm] = useState<AddGamePayload>(DEFAULT_ADD_FORM);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const selectedGame = useMemo(
    () => dashboard?.games.find((g) => g.id === selectedGameId) ?? null,
    [dashboard, selectedGameId],
  );

  useEffect(() => {
    if (hasLoadedRef.current) return;
    hasLoadedRef.current = true;
    void init();
  }, []);

  useEffect(() => {
    setSavePathDraft(selectedGame?.savePath ?? "");
  }, [selectedGame?.id, selectedGame?.savePath]);

  async function init() {
    setBusyLabel("Loading your game library...");
    setErrorMessage(null);
    try {
      applyDashboard(await loadDashboard(), selectedGameId);
    } catch (e) {
      setErrorMessage(msg(e, "Unable to load the dashboard."));
    } finally {
      setBusyLabel(null);
    }
  }

  function applyDashboard(next: DashboardData, preferredId?: string | null) {
    setDashboard(next);
    const fallback = next.games[0] ?? null;
    const selected = next.games.find((g) => g.id === preferredId) ?? fallback;
    setSelectedGameId(selected?.id ?? null);
  }

  async function handleRefresh() {
    setBusyLabel("Scanning launchers...");
    setErrorMessage(null);
    try {
      applyDashboard(await refreshDashboard(), selectedGameId);
    } catch (e) {
      setErrorMessage(msg(e, "Unable to refresh launchers."));
    } finally {
      setBusyLabel(null);
    }
  }

  async function handleBrowseInstallPath() {
    const p = await open({ directory: true, multiple: false, title: "Choose the game install folder" });
    if (typeof p === "string") setAddForm((c) => ({ ...c, installPath: p }));
  }

  async function handleBrowseSavePath() {
    const p = await open({ directory: true, multiple: false, title: "Choose the save game folder" });
    if (typeof p === "string") setSavePathDraft(p);
  }

  async function handleAddGame(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusyLabel("Saving game...");
    setErrorMessage(null);
    try {
      const next = await addManualGame({
        name: addForm.name.trim(),
        launcher: norm(addForm.launcher),
        installPath: norm(addForm.installPath),
      });
      const added = next.games.find(
        (g) => g.isManual && g.name.toLowerCase() === addForm.name.trim().toLowerCase(),
      );
      applyDashboard(next, added?.id ?? selectedGameId);
      setAddForm(DEFAULT_ADD_FORM);
    } catch (err) {
      setErrorMessage(msg(err, "Unable to add the game."));
    } finally {
      setBusyLabel(null);
    }
  }

  async function handleSavePath() {
    if (!selectedGame) return;
    setBusyLabel("Updating save folder...");
    setErrorMessage(null);
    try {
      applyDashboard(
        await updateGameSavePath({ ...selectedGame, savePath: norm(savePathDraft) }),
        selectedGame.id,
      );
    } catch (e) {
      setErrorMessage(msg(e, "Unable to save the folder path."));
    } finally {
      setBusyLabel(null);
    }
  }

  const games = dashboard?.games ?? [];
  const launcherCount = dashboard?.launchers.filter((l) => l.detected).length ?? 0;

  return (
    <main className="app-shell">
      {/* ── Sidebar ── */}
      <section className="sidebar-panel">
        <header className="hero-card">
          <p className="eyebrow">Windows save manager</p>
          <h1>Save Game Dashboard</h1>
          <p className="hero-copy">
            Detect installed games, add custom titles, and map each game to its save folder.
          </p>
          <div className="hero-stats">
            <div><span className="stat-value">{games.length}</span><span className="stat-label">Games tracked</span></div>
            <div><span className="stat-value">{launcherCount}</span><span className="stat-label">Launchers found</span></div>
          </div>
          <button className="primary-button" type="button" onClick={handleRefresh}>
            Refresh library
          </button>
        </header>

        <section className="launchers-card">
          <div className="section-heading">
            <h2>Launcher scan</h2>
            <span>{dashboard?.launchers.length ?? 0} sources</span>
          </div>
          <div className="launcher-grid">
            {(dashboard?.launchers ?? []).map((l) => (
              <article className="launcher-pill" key={l.id}>
                <div>
                  <strong>{l.name}</strong>
                  <p>{l.details ?? "No details yet"}</p>
                </div>
                <span className={l.detected ? "status-badge online" : "status-badge offline"}>
                  {l.detected ? `${l.gameCount} found` : "Not found"}
                </span>
              </article>
            ))}
          </div>
        </section>

        <section className="add-card">
          <div className="section-heading">
            <h2>Add game</h2>
            <span>Manual entry</span>
          </div>
          <form className="add-form" onSubmit={handleAddGame}>
            <label>
              <span>Game name</span>
              <input
                value={addForm.name}
                onChange={(e) => setAddForm((c) => ({ ...c, name: e.currentTarget.value }))}
                placeholder="Example: Elden Ring"
                required
              />
            </label>
            <label>
              <span>Launcher</span>
              <select
                value={addForm.launcher ?? "Manual"}
                onChange={(e) => setAddForm((c) => ({ ...c, launcher: e.currentTarget.value }))}
              >
                <option value="Manual">Manual</option>
                <option value="Steam">Steam</option>
                <option value="Epic Games">Epic Games</option>
                <option value="GOG Galaxy">GOG Galaxy</option>
                <option value="Other">Other</option>
              </select>
            </label>
            <label>
              <span>Install folder</span>
              <div className="input-row">
                <input
                  value={addForm.installPath ?? ""}
                  onChange={(e) => setAddForm((c) => ({ ...c, installPath: e.currentTarget.value }))}
                  placeholder="Optional install path"
                />
                <button type="button" className="secondary-button" onClick={handleBrowseInstallPath}>
                  Browse
                </button>
              </div>
            </label>
            <button className="primary-button" type="submit">Add game</button>
          </form>
        </section>
      </section>

      {/* ── Main content ── */}
      <section className="content-panel">
        <div className="toolbar">
          <div>
            <p className="eyebrow">Home</p>
            <h2>Installed and managed games</h2>
          </div>
          {busyLabel ? <span className="toolbar-note">{busyLabel}</span> : null}
        </div>

        {errorMessage ? <p className="message-banner error">{errorMessage}</p> : null}
        {!!dashboard?.warnings.length && (
          <div className="message-banner warning">
            <strong>Scan notes</strong>
            <ul>{dashboard.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
          </div>
        )}

        <div className="workspace-grid">
          {/* Game list */}
          <section className="games-list-card">
            <div className="section-heading">
              <h3>Games on this system</h3>
              <span>{games.length} entries</span>
            </div>
            <div className="games-list">
              {games.length === 0 ? (
                <div className="empty-state">
                  <p>No games detected yet.</p>
                  <span>Run a scan or add your first game manually.</span>
                </div>
              ) : (
                games.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    className={g.id === selectedGameId ? "game-card active" : "game-card"}
                    onClick={() => setSelectedGameId(g.id)}
                  >
                    <div className="game-card-header">
                      <strong>{g.name}</strong>
                      <span className={g.isAvailable ? "status-badge online" : "status-badge offline"}>
                        {g.isAvailable ? "Available" : "Missing"}
                      </span>
                    </div>
                    <div className="game-card-meta">
                      <span>{g.launcher}</span>
                      <span>{g.isManual ? "Manual" : g.source}</span>
                    </div>
                    <p>{g.installPath ?? "Install path not detected"}</p>
                  </button>
                ))
              )}
            </div>
          </section>

          {/* Detail panel */}
          <section className="detail-card">
            {selectedGame ? (
              <>
                <div className="detail-header">
                  <div>
                    <p className="eyebrow">Game details</p>
                    <h3>{selectedGame.name}</h3>
                  </div>
                  <div className="detail-badges">
                    <span className="soft-badge">{selectedGame.launcher}</span>
                    <span className="soft-badge">Confidence: {selectedGame.confidence}</span>
                  </div>
                </div>

                <dl className="detail-grid">
                  <div><dt>Install folder</dt><dd>{selectedGame.installPath ?? "Not set"}</dd></div>
                  <div><dt>Source</dt><dd>{selectedGame.source}</dd></div>
                  <div><dt>Mode</dt><dd>{selectedGame.isManual ? "Manual entry" : "Auto-detected"}</dd></div>
                  <div><dt>Status</dt><dd>{selectedGame.isAvailable ? "Available on this system" : "Saved mapping only"}</dd></div>
                </dl>

                <div className="save-form">
                  <label>
                    <span>Save folder</span>
                    <div className="input-row">
                      <input
                        value={savePathDraft}
                        onChange={(e) => setSavePathDraft(e.currentTarget.value)}
                        placeholder="Choose or enter the save folder path"
                      />
                      <button type="button" className="secondary-button" onClick={handleBrowseSavePath}>
                        Browse
                      </button>
                    </div>
                  </label>
                  <div className="detail-actions">
                    <button className="primary-button" type="button" onClick={handleSavePath}>
                      Save folder mapping
                    </button>
                    <button className="ghost-button" type="button" onClick={() => setSavePathDraft("")}>
                      Clear input
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="empty-state detail-empty">
                <p>Select a game from the list.</p>
                <span>Its install folder and save folder mapping will appear here.</span>
              </div>
            )}
          </section>
        </div>
      </section>
    </main>
  );
}

function norm(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

function msg(e: unknown, fallback: string): string {
  if (typeof e === "string") return e;
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

export default App;
