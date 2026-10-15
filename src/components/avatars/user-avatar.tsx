import { memo } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import { UserIcon } from '@hugeicons/core-free-icons'
import { cn } from '@/lib/utils'

type AvatarProps = {
  size?: number
  className?: string
  src?: string | null
  alt?: string
}

/**
 * User avatar — custom image when set, otherwise a generic person icon.
 */
function UserAvatarComponent({
  size = 28,
  className,
  src,
  alt = 'User avatar',
}: AvatarProps) {
  const radius = Math.max(6, Math.round(size * 0.2))

  if (src && src.trim().length > 0) {
    return (
      <img
        src={src}
        alt={alt}
        className={cn('shrink-0 object-cover', className)}
        style={{
          width: size,
          height: size,
          borderRadius: radius,
        }}
      />
    )
  }

  const iconSize = Math.max(12, Math.round(size * 0.55))

  return (
    <span
      role="img"
      aria-label={alt}
      className={cn(
        'inline-flex shrink-0 items-center justify-center bg-primary-200 text-primary-600 dark:bg-neutral-800 dark:text-neutral-300',
        className,
      )}
      style={{
        width: size,
        height: size,
        borderRadius: radius,
      }}
    >
      <HugeiconsIcon icon={UserIcon} size={iconSize} strokeWidth={1.75} />
    </span>
  )
}

export const UserAvatar = memo(UserAvatarComponent)
