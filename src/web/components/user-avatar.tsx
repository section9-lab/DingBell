import { cn } from 'cn';
import { avatarSrc } from '../lib/avatar';

function initials(name: string) {
  const value = name.trim();
  return (
    Array.from(value)
      .slice(0, /[^\x00-\x7F]/.test(value) ? 1 : 2)
      .join('')
      .toUpperCase() || '?'
  );
}

/**
 * Account avatars are decorative next to a visible name, so the image stays
 * hidden from assistive technology and the surrounding control owns the label.
 * `seed` is a final avatar seed; callers that only have a user id must pass
 * `defaultAvatarSeed(userId)` so the rendered SVG matches the saved URL.
 */
export function UserAvatar({
  name,
  image,
  seed,
  size = 36,
  className,
}: {
  name: string;
  image?: string | null;
  seed?: string;
  size?: number;
  className?: string;
}) {
  const src = avatarSrc(image, seed);
  if (src)
    return (
      <img
        src={src}
        alt=""
        aria-hidden="true"
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        className={cn(
          'shrink-0 rounded-full bg-[var(--bg-sunken)] object-cover ring-1 ring-border/60',
          className,
        )}
        style={{ width: size, height: size }}
      />
    );
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid shrink-0 place-items-center rounded-full bg-[var(--bg-sunken)] text-[11px] font-semibold text-[var(--text-2)] ring-1 ring-border/60',
        className,
      )}
      style={{ width: size, height: size }}
    >
      {initials(name)}
    </span>
  );
}
