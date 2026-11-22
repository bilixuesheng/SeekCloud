import { GitHubMark } from "./GitHubMark";
import { ChatIcon, ChipIcon, DatabaseIcon, SettingsIcon, UserIcon } from "./Icons";
import { t } from "./i18n";
import { LegalPage } from "./legal/LegalPage";
import type { OverlayProps, PageProps, Registry } from "./registry";
import { AwaitingInputHint } from "./session/AwaitingInputHint";
import { NewSession } from "./session/NewSession";
import { SessionPage } from "./session/SessionPage";
import { DataSettings } from "./settings/DataSettings";
import { GeneralSettings } from "./settings/GeneralSettings";
import { ModelSettings } from "./settings/ModelSettings";
import { SessionSettings } from "./settings/SessionSettings";
import { AccountSettings, GitHubSettings, SettingsDialog } from "./settings/SettingsDialog";
import { useShell } from "./shell";

/** 首页：问候语和发起会话的输入框。 */
function HomePage() {
  const { me, notice, overlayOpen, upsert } = useShell();
  return (
    <main className="home">
      <div className="home-inner">
        {/* 设置开着时，出的问题显示在设置里 */}
        {notice && !overlayOpen && (
          <p className="alert" role="alert">
            {notice}
          </p>
        )}
        <NewSession nickname={me.nickname} onCreated={upsert} />
      </div>
    </main>
  );
}

function SessionRoute({ params }: PageProps) {
  const { sessions, openDrawer } = useShell();
  const id = params.id as string;
  return (
    <SessionPage id={id} listed={sessions.find((s) => s.shortId === id)} onMenu={openDrawer} />
  );
}

function SettingsRoute({ params, closing, onClose }: OverlayProps) {
  const { notice, onSignedOut, onProfileChanged } = useShell();
  return (
    <SettingsDialog
      section={params.section}
      closing={closing}
      notice={notice}
      onClose={onClose}
      onSignedOut={onSignedOut}
      onGitHubChanged={onProfileChanged}
      onProfileChanged={onProfileChanged}
    />
  );
}

const LicensesPage = () => <LegalPage doc="licenses" />;

/** 主干自己的页面和设置分类。main.tsx 挂载之前登记；下游在这之后登记自己的，同名的盖掉主干的。 */
export function registerTrunk(registry: Registry): Registry {
  return (
    registry
      .page({ id: "home", path: "/", component: HomePage })
      .page({ id: "session", path: "/s/:id", component: SessionRoute, ownHeader: true })
      .page({
        id: "settings",
        path: "/settings/:section?",
        component: SettingsRoute,
        overlay: true,
      })
      .page({ id: "licenses", path: "/licenses", component: LicensesPage, public: true })
      // 首页问候语下方："有会话在等你输入"（#139）
      .slot("home-below-greeting", {
        id: "awaiting-input",
        component: AwaitingInputHint,
        order: 10,
      })
      .settings({
        id: "general",
        name: () => t("settings.section.general"),
        icon: <SettingsIcon />,
        component: GeneralSettings,
        order: 10,
      })
      .settings({
        id: "model",
        name: () => t("settings.section.model"),
        icon: <ChipIcon />,
        component: ModelSettings,
        order: 12,
      })
      .settings({
        id: "sessions",
        name: () => t("settings.section.sessions"),
        icon: <ChatIcon />,
        component: SessionSettings,
        order: 15,
      })
      .settings({
        id: "github",
        name: () => t("settings.section.github"),
        icon: <GitHubMark size={15} />,
        component: GitHubSettings,
        order: 20,
      })
      .settings({
        id: "account",
        name: () => t("settings.section.account"),
        icon: <UserIcon />,
        component: AccountSettings,
        order: 30,
      })
      .settings({
        id: "data",
        name: () => t("settings.section.data"),
        icon: <DatabaseIcon />,
        component: DataSettings,
        order: 40,
      })
  );
}
