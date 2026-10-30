import { ButtonLink, EmptyState } from "../components/ui";
import { IconMap } from "../components/Icons";
import { useT } from "../i18n";

export default function NotFound({ inApp }: { inApp?: boolean }) {
  const { t } = useT();
  return (
    <div className="page" style={{ display: "grid", placeItems: "center", minHeight: inApp ? "60vh" : "100vh" }}>
      <EmptyState icon={<IconMap size={20} />} title={t("notFound.title")} action={<ButtonLink to={inApp ? "/app" : "/"} variant="primary">{inApp ? t("notFound.back") : t("notFound.home")}</ButtonLink>}>
        {t("notFound.body")}
      </EmptyState>
    </div>
  );
}
