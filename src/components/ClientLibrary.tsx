import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { Track } from '../hooks/usePlayer'
import type { Library } from '../hooks/useLibrary'

const fontMono    = { fontFamily: "'IBM Plex Mono', monospace" }
const fontAssist  = { fontFamily: "'Assistant', sans-serif" }

const CATEGORY_LABELS: Record<string, string> = {
  morning: 'MORNING',
  day:     'DAY',
  evening: 'EVENING',
}

const TOD_HOURS: Record<string, string> = {
  morning: '06–12',
  day:     '12–18',
  evening: '18–06',
}

interface Props {
  library:            Library
  loading:            boolean
  currentTrack:       Track | null
  replaceQueueAndPlay:(tracks: Track[], index: number) => void
}

export default function ClientLibrary({ library, loading, currentTrack, replaceQueueAndPlay }: Props) {
  const [open, setOpen] = useState<Record<string, boolean>>({
    morning: false,
    day:     false,
    evening: false,
  })

  const toggle = (cat: string) =>
    setOpen(prev => ({ ...prev, [cat]: !prev[cat] }))

  const categories = ['morning', 'day', 'evening'] as const

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* section label */}
      <div className="px-5 pt-3 pb-1 shrink-0 flex items-center gap-2">
        <span style={fontMono} className="text-[8px] tracking-[0.45em] uppercase text-[#2e2e2e]">
          LIBRARY
        </span>
        {loading && (
          <span style={fontMono} className="text-[8px] text-[#1e1e1e]">···</span>
        )}
      </div>

      {/* vertical list of collapsible folders */}
      <div className="flex-1 overflow-y-auto lib-scroll">
        {categories.map(cat => {
          const tracks = library[cat]
          const isOpen = open[cat]

          return (
            <div key={cat} className="border-b border-[#1c1c1c] last:border-b-0">
              {/* folder header */}
              <button
                onClick={() => toggle(cat)}
                className="w-full text-left px-5 py-3 flex items-center gap-3 hover:bg-[#181818] transition-colors cursor-pointer"
              >
                <motion.span
                  animate={{ rotate: isOpen ? 90 : 0 }}
                  transition={{ type: 'spring', stiffness: 600, damping: 36 }}
                  style={fontMono}
                  className="text-[9px] text-[#555555] leading-none shrink-0"
                >
                  ▶
                </motion.span>
                <span
                  style={{ ...fontAssist, fontWeight: 700, fontSize: '13px', letterSpacing: '0.06em' }}
                  className="uppercase text-white flex-1 tracking-wide"
                >
                  {CATEGORY_LABELS[cat]}
                </span>
                <span style={fontMono} className="text-[8px] tracking-[0.1em] text-[#383838] shrink-0">
                  {TOD_HOURS[cat]}
                </span>
                <span style={{ ...fontAssist, fontWeight: 400, fontSize: '11px' }} className="text-[#333333] shrink-0 ml-1.5">
                  {tracks.length}
                </span>
              </button>

              {/* track list — expands downward */}
              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.18, ease: 'easeInOut' }}
                    style={{ overflow: 'hidden' }}
                  >
                    {tracks.length === 0 ? (
                      <div className="px-7 py-2">
                        <span style={fontMono} className="text-[8px] text-[#282828] tracking-[0.2em]">EMPTY</span>
                      </div>
                    ) : (
                      tracks.map((track, i) => {
                        const isActive = currentTrack?.id === track.id
                        return (
                          <motion.button
                            key={track.id}
                            whileHover={{ x: 3 }}
                            transition={{ duration: 0.07 }}
                            onClick={() => replaceQueueAndPlay(tracks, i)}
                            className={`w-full text-left flex items-center cursor-pointer transition-colors ${
                              isActive ? 'bg-[#1e1e1e]' : 'hover:bg-[#181818]'
                            }`}
                            style={{
                              paddingLeft: '32px',
                              paddingRight: '20px',
                              paddingTop: '7px',
                              paddingBottom: '7px',
                              borderLeft: isActive ? '2px solid #888888' : '2px solid transparent',
                            }}
                          >
                            <div className="flex-1 min-w-0">
                              <div
                                style={{ ...fontAssist, fontWeight: isActive ? 600 : 400, fontSize: '12px' }}
                                className={`leading-snug truncate ${isActive ? 'text-white' : 'text-[#cccccc]'}`}
                              >
                                {track.title}
                              </div>
                              <div
                                style={{ ...fontAssist, fontWeight: 400, fontSize: '11px' }}
                                className={`leading-snug truncate mt-0.5 ${isActive ? 'text-[#888888]' : 'text-[#555555]'}`}
                              >
                                {track.artist}
                              </div>
                            </div>
                          </motion.button>
                        )
                      })
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )
        })}
      </div>
    </div>
  )
}
