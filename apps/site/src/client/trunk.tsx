import { GitHubMark } from "./GitHubMark";
import { ChatIcon, ChipIcon, DatabaseIcon, SettingsIcon, UserIcon } from "./Icons";
import { LegalPage } from "./legal/LegalPage";
import type { OverlayProps, PageProps, Registry } from "./registry";
import { NewSession } from "./session/NewSession";
import { SessionPage } from "./session/SessionPage";
import { DataSettings } from "./settings/DataSettings";
import { ModelSettings } from "./settings/ModelSettings";
import { SessionSettings } from "./settings/SessionSettings";
import {
  AccountSettings,
  GeneralSettings,
  GitHubSettings,
  SettingsDialog,
} from "./settings/SettingsDialog";
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
  return registry
    .page({ id: "home", path: "/", component: HomePage })
    .page({ id: "session", path: "/s/:id", component: SessionRoute, ownHeader: true })
    .page({ id: "settings", path: "/settings/:section?", component: SettingsRoute, overlay: true })
    .page({ id: "licenses", path: "/licenses", component: LicensesPage, public: true })
    .settings({
      id: "general",
      name: "通用",
      icon: <SettingsIcon />,
      component: GeneralSettings,
      order: 10,
    })
    .settings({
      id: "model",
      name: "模型",
      icon: <ChipIcon />,
      component: ModelSettings,
      order: 12,
    })
    .settings({
      id: "sessions",
      name: "会话",
      icon: <ChatIcon />,
      component: SessionSettings,
      order: 15,
    })
    .settings({
      id: "github",
      name: "GitHub",
      icon: <GitHubMark size={15} />,
      component: GitHubSettings,
      order: 20,
    })
    .settings({
      id: "account",
      name: "账户",
      icon: <UserIcon />,
      component: AccountSettings,
      order: 30,
    })
    .settings({
      id: "data",
      name: "数据",
      icon: <DatabaseIcon />,
      component: DataSettings,
      order: 40,
    });
}
