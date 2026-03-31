import { CARD, EYEBROW, MUTED } from "../components/styles";

export function SettingsPage() {
  return (
    <>
      <div>
        <p className={EYEBROW}>Configuration</p>
        <h2 className="m-0">Settings</h2>
      </div>

      <div className={CARD}>
        <h3 className="m-0 mb-2 font-semibold">Google Account</h3>
        <p className={MUTED}>Connected to Google — account details will appear here.</p>
      </div>

      <div className={CARD}>
        <h3 className="m-0 mb-2 font-semibold">Sync preferences</h3>
        <p className={MUTED}>Global sync settings — coming soon.</p>
      </div>

      <div className={CARD}>
        <h3 className="m-0 mb-2 font-semibold">Startup &amp; Background</h3>
        <p className={MUTED}>System tray and Windows startup options — coming soon.</p>
      </div>
    </>
  );
}
