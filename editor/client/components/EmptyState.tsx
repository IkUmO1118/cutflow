import type { ReactNode } from "react";
import { LoaderCircle, TriangleAlert } from "lucide-react";

export const EmptyState = ({
  icon,
  title,
  description,
  actions,
  className = "",
}: {
  icon: ReactNode;
  title: string;
  description: ReactNode;
  actions?: ReactNode;
  className?: string;
}) => (
  <div className={`emptyState${className ? ` ${className}` : ""}`}>
    <div className="emptyStateIcon" aria-hidden>{icon}</div>
    <div className="emptyStateCopy">
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
    {actions && <div className="emptyStateActions">{actions}</div>}
  </div>
);

export const AppStateView = ({
  kind,
  title,
  description,
}: {
  kind: "loading" | "error";
  title: string;
  description?: ReactNode;
}) => (
  <main className={`appStateView ${kind}`} aria-live={kind === "error" ? "assertive" : "polite"}>
    <div className="appStateMark" aria-hidden>
      {kind === "loading"
        ? <LoaderCircle className="appStateSpinner" size={22} />
        : <TriangleAlert size={22} />}
    </div>
    <div>
      <h1>{title}</h1>
      {description && <p>{description}</p>}
    </div>
  </main>
);
