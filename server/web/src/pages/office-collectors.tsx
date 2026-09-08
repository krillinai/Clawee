import { CollectorManagementView } from "@/components/collectors/collector-management-view";
import { useNavigate, useSearchParams } from "react-router-dom";

export function OfficeCollectorsPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  return (
    <CollectorManagementView
      onCloseDetail={() => navigate("/admin/collectors")}
      selectedCollectorID={searchParams.get("collector_id")}
    />
  );
}
