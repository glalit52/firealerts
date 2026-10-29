import { ButtonLink, EmptyState } from "../components/ui";
import { IconMap } from "../components/Icons";

export default function NotFound({ inApp }: { inApp?: boolean }) {
  return (
    <div className="page" style={{ display: "grid", placeItems: "center", minHeight: inApp ? "60vh" : "100vh" }}>
      <EmptyState icon={<IconMap size={20} />} title="Page not found" action={<ButtonLink to={inApp ? "/app" : "/"} variant="primary">{inApp ? "Back to overview" : "Go home"}</ButtonLink>}>
        The page you're looking for doesn't exist or has moved.
      </EmptyState>
    </div>
  );
}
