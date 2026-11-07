/**
 * Brick-risk classifier: the one list of command shapes that can leave an
 * Android device unbootable or wipe it.
 *
 * Parakeet's Root permission (设置 › 系统权限 › Root) makes every shell command
 * the agent runs execute as uid 0 with no per-command prompt. These shapes are
 * the single exception: they are confirmed once, by the user, every time —
 * writing a partition, re-mounting or writing a system-type partition
 * (/system, /vendor, /product, /system_ext, /odm, boot, recovery, vbmeta,
 * super), formatting or wiping /data or /metadata, flashing, and partition
 * table edits.
 *
 * Deny-by-default-confirm: an unclear shape that touches those paths is
 * confirmed rather than waved through. Nothing else is blocked or asked about.
 *
 * Pure string matching, so it is unit testable on Linux CI and usable from both
 * the DSH plugin (approval gate) and the host runtime.
 *
 * @module @parakeet/dsh-plugin-root-shell/brick
 */

/** Partitions whose contents, mounted read-write or overwritten, can brick a phone. */
export const SYSTEM_PARTITIONS = ['system', 'vendor', 'product', 'system_ext', 'odm', 'oem', 'apex'];

/** Named partitions a flash/dd usually targets by name. */
export const PARTITION_NAMES = [
  'boot', 'init_boot', 'recovery', 'vbmeta', 'vbmeta_system', 'super', 'dtbo',
  'vendor_boot', 'modem', 'abl', 'xbl', 'bootloader', 'persist', 'efs', 'nvram', 'preloader',
];

const partitionPath = `/(?:${SYSTEM_PARTITIONS.join('|')})`;

/**
 * Command shapes that are confirmed with the user even when Root is granted.
 * Each entry is [reason, regex]; the reason is shown in the confirmation.
 */
export const BRICK_PATTERNS = [
  // Writing a block device by any of the usual means (a path that merely contains
  // /dev/block/ counts too: deny-by-default-confirm).
  ['writes a raw block device (/dev/block)', /\bof=\S*\/dev\/block\//],
  ['writes a raw block device (/dev/block)', /\b(?:cp|mv|install|tee)\b[^\n;|&]*\s\S*\/dev\/block\/\S*\s*(?:$|[;|&)])/],
  ['writes a raw block device (/dev/block)', /\btee\b[^\n;|&]*\s\S*\/dev\/block\//],
  ['redirects output into a block device (/dev/block)', />>?\s*\S*\/dev\/block\//],
  ['writes a raw block device by partition name', new RegExp(String.raw`\bof=/dev/(?:block/)?(?:by-name|bootdevice|mapper)/`)],
  // Flashing.
  ['flashes a partition', /\b(?:fastboot|flash_image|flashboot|edl|mtk-su\s+flash)\b[^\n]*\bflash\b|\bflash_image\b|\bfastboot\b[^\n]*\b(?:flash|erase|format)\b/],
  ['writes a boot image through the Magisk/KernelSU installer', /\b(?:magiskboot|ksuinit|bootctl)\b[^\n]*\b(?:flash|write|repack|set-active-boot-slot)\b/],
  // Filesystem creation / formatting / wiping.
  ['formats a filesystem', /\b(?:mkfs(?:\.\w+)?|make_ext4fs|mke2fs|mkswap|mkdosfs|newfs_msdos|f2fs_format|format)\b/],
  ['wipes the device or a partition', /\b(?:wipe|factory_?reset)\b|--wipe_data|\brecovery\s+--wipe/],
  ['erases user data', new RegExp(String.raw`\b(?:rm|busybox\s+rm|toybox\s+rm)\s+(?:-[a-zA-Z]+\s+)*/(?:data|metadata)(?:/\*)?\s*(?:;|&|\||$)`)],
  ['erases a system partition', new RegExp(String.raw`\b(?:rm|busybox\s+rm|toybox\s+rm|find)\s[^\n;|&]*\s${partitionPath}(?:/|\s|$)`)],
  // Mounting a system-type partition read-write, and writing into one.
  ['remounts a system partition read-write', new RegExp(String.raw`\b(?:mount|remount)\b[^\n;|&]*(?:-o\s*[^\s]*\brw\b|--rw\b|-w\b)[^\n;|&]*${partitionPath}(?:\s|/|$)`)],
  ['remounts a system partition read-write', new RegExp(String.raw`\b(?:mount)\b[^\n;|&]*${partitionPath}(?:\s|/|$)[^\n;|&]*-o\s*[^\s]*\brw\b`)],
  ['remounts the system partitions read-write', /\b(?:magisk\s+--remount-rw|remount)\s*(?:;|&|\||$)|\bmount\s+-o\s+remount,rw\b|\badb\s+remount\b/],
  ['writes into a system partition', new RegExp(String.raw`>>?\s*${partitionPath}/`)],
  ['writes into a system partition', new RegExp(String.raw`\b(?:cp|mv|install|ln|rsync)\b[^\n;|&]*\s${partitionPath}/\S*\s*(?:$|[;|&)])`)],
  ['writes into a system partition', new RegExp(String.raw`\b(?:tee|truncate|touch|mkdir|rmdir|unlink|shred)\b[^\n;|&]*\s${partitionPath}/`)],
  ['writes into a system partition', new RegExp(String.raw`\b(?:tar|unzip|bsdtar|cpio)\b[^\n;|&]*(?:-C|-d)\s*${partitionPath}(?:/|\s|$)`)],
  ['edits a file in a system partition in place', new RegExp(String.raw`\b(?:sed|perl)\s+(?:[^\n;|&]*\s)?-[a-zA-Z]*i[^\n;|&]*\s${partitionPath}/`)],
  ['writes into a system partition', new RegExp(String.raw`\bof=${partitionPath}/`)],
  ["changes a system partition's files", new RegExp(String.raw`\b(?:chmod|chown|chcon|setfattr|ln\s+-s[^\n]*)\s[^\n;|&]*\s${partitionPath}/`)],
  // Partition tables and device mapper.
  ['edits the partition table', /\b(?:sgdisk|gdisk|parted|fdisk|sfdisk|partx|blockdev\s+--setrw)\b/],
  ['reconfigures the device mapper', /\b(?:dmsetup|lpmake|lpdump\s+--?w|lptools|resize2fs\s+\/dev\/block)\b/],
  // Bootloader / verified boot state.
  ['changes verified boot or the bootloader', /\b(?:avbctl|vbmeta|oem\s+unlock|flashing\s+unlock)\b/],
  ['writes a partition by name', new RegExp(String.raw`\b(?:${PARTITION_NAMES.join('|')})\b[^\n]*\bof=/dev/`)],
];

/**
 * Classify one shell command.
 * @param {string} command - the command text as the agent wrote it.
 * @returns {{risk: boolean, reason?: string}} risk true when it must be confirmed.
 */
export function brickRisk(command) {
  const text = typeof command === 'string' ? command : '';
  if (text.trim().length === 0) return { risk: false };
  for (const [reason, re] of BRICK_PATTERNS) {
    if (re.test(text)) return { risk: true, reason };
  }
  return { risk: false };
}

/**
 * Whether a command must be confirmed even with Root granted.
 * @param {string} command - the command text.
 * @returns {boolean} true for a device-level destructive shape.
 */
export function isBrickRisk(command) {
  return brickRisk(command).risk;
}
