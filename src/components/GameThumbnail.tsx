import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { getLogoDataUrl } from "../services/tauri";
import { toImgSrc } from "../utils";

function isDriveThumbnail(src: string) {
  return src.startsWith("drive-file:") || src.startsWith("gdrive-img://");
}

interface Props {
  src: string | null | undefined;
  alt?: string;
  className?: string;
  fallback?: React.ReactNode;
}

/**
 * Renders a game thumbnail image.
 * - http/https URLs and local file paths are rendered directly via toImgSrc().
 * - drive-file:{id} thumbnails are fetched async from Drive (returns a base64 data URL).
 * Shows a pulse skeleton while loading Drive images.
 */
export function GameThumbnail({ src, alt = "", className = "", fallback }: Props) {
  const [errored, setErrored] = useState(false);
  const isDrive = !!src && isDriveThumbnail(src);

  const { data: dataUrl } = useQuery({
    queryKey: ["logo-data-url", src],
    queryFn: () => getLogoDataUrl(src!),
    enabled: isDrive && !errored,
    staleTime: 1000 * 60 * 60, // 1 hour — logos rarely change
    retry: false,
  });

  if (errored) {
    return (
      <>
        {fallback ?? (
          <div className="grid place-items-center w-full h-full text-[#9aa8c7] text-lg">
            🎮
          </div>
        )}
      </>
    );
  }

  if (isDrive) {
    if (!dataUrl) {
      // Still loading
      return <div className="w-full h-full animate-pulse bg-[rgba(165,185,255,0.08)]" />;
    }
    return (
      <img
        src={dataUrl}
        alt={alt}
        className={className}
        onError={() => setErrored(true)}
      />
    );
  }

  const imgSrc = toImgSrc(src);
  if (!imgSrc) return null;

  return (
    <img
      src={imgSrc}
      alt={alt}
      className={className}
      onError={() => setErrored(true)}
    />
  );
}
