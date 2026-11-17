/**
 * Monster Energy tracker — draggable Web UI can with a seven-day popup.
 *
 * Lives in the frame-wide `shell.overlay` slot. A click (without dragging)
 * opens a small bar chart of the last seven local days; dragging moves the
 * card and stores the position in localStorage. Polls the Host's read-only
 * `/monster-tracker/state` route for the current figures.
 *
 * The can is inline SVG rather than an image URL, so it needs no asset route,
 * data URL, or packaging step.
 */

window.__ModuleLoader__.load({
  id: '@local/monster-tracker',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'monsterTracker'
    const POSITION_KEY = 'dsh.monster-tracker.float.v1'
    const CARD_WIDTH = 116
    const CARD_HEIGHT = 180
    const POPUP_MAX_WIDTH = 288
    const POPUP_HEIGHT = 214
    const EDGE = 20
    const DRAG_THRESHOLD = 4
    const dictionaries = {
      en: {
        today: 'today',
        total: 'total',
        unavailable: 'tracker unavailable',
        loading: 'loading',
        dragHint: 'Click for the last 7 days · drag to move',
        last7Days: 'Last 7 days',
        weekTotal: '7-day total',
        resetPosition: 'Reset position',
        close: 'Close',
        noWeekData: 'No daily data available',
      },
      zh: {
        today: '今天',
        total: '总计',
        unavailable: '记录暂不可用',
        loading: '加载中',
        dragHint: '点击查看近 7 天 · 拖动可移动',
        last7Days: '近 7 天',
        weekTotal: '7 天总计',
        resetPosition: '复位',
        close: '关闭',
        noWeekData: '暂无每日数据',
      },
    }
    const english = dictionaries.en
    const fallback = key => english[key] ?? key

    function clampPosition(position) {
      const maxX = Math.max(EDGE, window.innerWidth - CARD_WIDTH - EDGE)
      const maxY = Math.max(EDGE, window.innerHeight - CARD_HEIGHT - EDGE)
      return {
        x: Math.min(Math.max(position.x, EDGE), maxX),
        y: Math.min(Math.max(position.y, EDGE), maxY),
      }
    }

    function defaultPosition() {
      return clampPosition({
        x: EDGE,
        y: window.innerHeight - CARD_HEIGHT - EDGE,
      })
    }

    function readPosition() {
      try {
        const raw = window.localStorage.getItem(POSITION_KEY)
        if (raw !== null) {
          const parsed = JSON.parse(raw)
          if (parsed !== null && typeof parsed === 'object'
            && Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
            return clampPosition({ x: parsed.x, y: parsed.y })
          }
        }
      } catch (error) {
        // A blocked or corrupt store falls back to the default corner.
      }
      return defaultPosition()
    }

    function writePosition(position) {
      try {
        window.localStorage.setItem(POSITION_KEY, JSON.stringify(position))
      } catch (error) {
        // The card still moves for this visit when storage is unavailable.
      }
    }

    /** Place the popup beside the card, flipping or centering when space is tight. */
    function popupLayout(card) {
      const width = Math.min(POPUP_MAX_WIDTH, Math.max(200, window.innerWidth - 20))
      const maxX = Math.max(10, window.innerWidth - width - 10)
      const maxY = Math.max(10, window.innerHeight - POPUP_HEIGHT - 10)
      const right = card.x + CARD_WIDTH + 10
      const left = card.x - width - 10
      let x = right <= maxX ? right : left >= 10 ? left : Math.min(Math.max((window.innerWidth - width) / 2, 10), maxX)
      let y = Math.min(Math.max(card.y + 10, 10), maxY)
      // If the chosen side still overlaps the card horizontally, move above it.
      if (x < card.x + CARD_WIDTH && x + width > card.x) {
        const above = card.y - POPUP_HEIGHT - 10
        y = above >= 10 ? above : card.y + CARD_HEIGHT + 10
        y = Math.min(Math.max(y, 10), maxY)
      }
      return { x, y, width }
    }

    function weekdayLabel(date) {
      const parsed = new Date(`${date}T12:00:00`)
      return Number.isNaN(parsed.getTime())
        ? ''
        : parsed.toLocaleDateString(undefined, { weekday: 'short' })
    }

    /** One simple energy-drink can: dark body, silver lid, green lightning bolt. */
    function CanArt(props) {
      return h('svg', {
        viewBox: '0 0 64 96',
        width: 84,
        height: 120,
        'aria-hidden': true,
        focusable: 'false',
        style: {
          display: 'block',
          pointerEvents: 'none',
          opacity: props.dim ? 0.55 : 1,
        },
      },
      h('rect', { x: 14, y: 6, width: 36, height: 84, rx: 8, fill: '#2f3e50' }),
      h('rect', { x: 14, y: 6, width: 36, height: 12, rx: 6, fill: '#a9bccd' }),
      h('rect', { x: 17, y: 9, width: 30, height: 4, rx: 2, fill: '#dce7f2' }),
      h('rect', { x: 14, y: 20, width: 36, height: 2.5, fill: '#57e389' }),
      h('rect', { x: 18, y: 26, width: 3, height: 46, rx: 1.5, fill: '#ffffff', opacity: 0.08 }),
      h('path', { d: 'M37 29 L23 52 H31 L27 69 L43 44 H34 Z', fill: '#57e389' }),
      h('rect', { x: 14, y: 78, width: 36, height: 12, rx: 6, fill: '#243241' }),
      h('rect', { x: 19, y: 74, width: 26, height: 2, rx: 1, fill: '#57e389' }))
    }

    function MonsterCan(props) {
      const t = props.t ?? fallback
      const [counts, setCounts] = React.useState(null)
      const [failed, setFailed] = React.useState(false)
      const [position, setPosition] = React.useState(readPosition)
      const [dragging, setDragging] = React.useState(false)
      const [open, setOpen] = React.useState(false)
      const positionRef = React.useRef(position)
      const dragRef = React.useRef(null)
      const rootRef = React.useRef(null)
      const cardRef = React.useRef(null)
      const closeButtonRef = React.useRef(null)
      positionRef.current = position

      React.useEffect(() => {
        let stopped = false
        let controller
        const load = async () => {
          controller?.abort()
          controller = new AbortController()
          try {
            const response = await fetch('/monster-tracker/state', {
              cache: 'no-store',
              credentials: 'same-origin',
              signal: controller.signal,
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const data = await response.json()
            if (stopped) return
            if (Number.isInteger(data.todayCans) && Number.isInteger(data.totalCans)) {
              const days = Array.isArray(data.days)
                ? data.days
                  .filter(day => day !== null && typeof day === 'object'
                    && typeof day.date === 'string' && Number.isInteger(day.cans))
                  .slice(-7)
                : []
              setCounts({ todayCans: data.todayCans, totalCans: data.totalCans, days })
              setFailed(false)
            }
          } catch (error) {
            if (!stopped && error?.name !== 'AbortError') setFailed(true)
          }
        }
        void load()
        const timer = window.setInterval(load, 3000)
        const onVisible = () => {
          if (document.visibilityState === 'visible') void load()
        }
        document.addEventListener('visibilitychange', onVisible)
        window.addEventListener('focus', load)
        return () => {
          stopped = true
          window.clearInterval(timer)
          controller?.abort()
          document.removeEventListener('visibilitychange', onVisible)
          window.removeEventListener('focus', load)
        }
      }, [])

      React.useEffect(() => {
        const onResize = () => {
          const next = clampPosition(positionRef.current)
          positionRef.current = next
          setPosition(next)
          writePosition(next)
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [])

      const closePopup = restoreFocus => {
        setOpen(false)
        if (restoreFocus) {
          try { cardRef.current?.focus() } catch (error) {}
        }
      }

      React.useEffect(() => {
        if (!open) return undefined
        try { closeButtonRef.current?.focus() } catch (error) {}
        const onDocumentKeyDown = event => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          closePopup(true)
        }
        const onDocumentPointerDown = event => {
          if (rootRef.current?.contains(event.target)) return
          closePopup(false)
        }
        document.addEventListener('keydown', onDocumentKeyDown, true)
        document.addEventListener('pointerdown', onDocumentPointerDown, true)
        return () => {
          document.removeEventListener('keydown', onDocumentKeyDown, true)
          document.removeEventListener('pointerdown', onDocumentPointerDown, true)
        }
      }, [open])

      const moveTo = next => {
        positionRef.current = next
        setPosition(next)
      }

      const onPointerDown = event => {
        if (event.pointerType === 'mouse' && event.button !== 0) return
        event.preventDefault()
        try { cardRef.current?.focus() } catch (error) {}
        try { event.currentTarget.setPointerCapture(event.pointerId) } catch (error) {}
        dragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          origin: positionRef.current,
          moved: false,
        }
        setDragging(true)
      }

      const onPointerMove = event => {
        const active = dragRef.current
        if (active === null || active.pointerId !== event.pointerId) return
        const distance = Math.hypot(event.clientX - active.startX, event.clientY - active.startY)
        if (!active.moved && distance <= DRAG_THRESHOLD) return
        active.moved = true
        moveTo(clampPosition({
          x: active.origin.x + event.clientX - active.startX,
          y: active.origin.y + event.clientY - active.startY,
        }))
      }

      const finishDrag = event => {
        const active = dragRef.current
        if (active === null) return
        dragRef.current = null
        setDragging(false)
        try { event.currentTarget.releasePointerCapture(event.pointerId) } catch (error) {}
        if (active.moved) {
          writePosition(positionRef.current)
        } else {
          setOpen(value => !value)
        }
      }

      const resetPosition = () => {
        const next = defaultPosition()
        moveTo(next)
        writePosition(next)
        closePopup(true)
      }

      const onKeyDown = event => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        setOpen(true)
      }

      const loading = counts === null && !failed
      const todayCans = counts?.todayCans ?? 0
      const totalCans = counts?.totalCans ?? 0
      const days = counts?.days ?? []
      const hasDays = days.length === 7
      const weekTotal = days.reduce((sum, day) => sum + day.cans, 0)
      const maxCans = Math.max(1, ...days.map(day => day.cans))
      const badge = loading ? '…' : String(todayCans)
      const label = failed
        ? t('unavailable')
        : loading
          ? t('loading')
          : `Monster Energy: ${todayCans} today, ${totalCans} total`
      const lineColor = failed ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-primary)'
      const popup = open ? popupLayout(position) : null
      const secondary = 'var(--dsw-alias-label-secondary)'
      const primary = 'var(--dsw-alias-label-primary)'

      const chart = failed
        ? h('p', { style: { margin: '18px 0', color: 'var(--dsw-alias-state-warn-primary)', fontSize: 12, textAlign: 'center' } }, t('unavailable'))
        : !hasDays
          ? h('p', { style: { margin: '18px 0', color: secondary, fontSize: 12, textAlign: 'center' } }, t('noWeekData'))
          : h(React.Fragment, null,
            h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: 5, height: 92 } },
              ...days.map((day, index) => {
                const isToday = index === days.length - 1
                const barHeight = Math.max(day.cans === 0 ? 4 : 8, Math.round(day.cans / maxCans * 76))
                return h('div', {
                  key: day.date,
                  'data-day': day.date,
                  style: {
                    flex: '1 1 0',
                    minWidth: 0,
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'flex-end',
                    gap: 2,
                  },
                },
                h('span', {
                  style: { fontSize: 10, lineHeight: '12px', color: isToday ? primary : secondary },
                }, String(day.cans)),
                h('div', {
                  title: `${day.date}: ${day.cans}`,
                  style: {
                    width: '100%',
                    maxWidth: 20,
                    height: barHeight,
                    borderRadius: 4,
                    background: isToday ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-layer-2)',
                    border: isToday ? 'none' : '1px solid var(--dsw-alias-border-l1)',
                    boxSizing: 'border-box',
                  },
                }))
              })),
            h('div', { style: { display: 'flex', gap: 5, marginTop: 4 } },
              ...days.map((day, index) => h('span', {
                key: day.date,
                style: {
                  flex: '1 1 0',
                  minWidth: 0,
                  textAlign: 'center',
                  fontSize: 9.5,
                  color: index === days.length - 1 ? primary : secondary,
                  whiteSpace: 'nowrap',
                },
              }, weekdayLabel(day.date)))))

      return h('div', {
        ref: rootRef,
        style: {
          position: 'fixed',
          left: position.x,
          top: position.y,
          width: CARD_WIDTH,
          zIndex: 9000,
          pointerEvents: 'none',
        },
      },
      h('div', {
        ref: cardRef,
        'data-monster-tracker': 'float',
        role: 'group',
        tabIndex: 0,
        'aria-label': label,
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        title: t('dragHint'),
        onPointerDown,
        onPointerMove,
        onPointerUp: finishDrag,
        onPointerCancel: finishDrag,
        onKeyDown,
        style: {
          position: 'relative',
          width: '100%',
          pointerEvents: 'auto',
          touchAction: 'none',
          cursor: dragging ? 'grabbing' : 'grab',
          userSelect: 'none',
          WebkitUserSelect: 'none',
        },
      },
      h('div', {
        style: {
          position: 'relative',
          boxSizing: 'border-box',
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 2,
          padding: '8px 8px 6px',
          borderRadius: 16,
          border: dragging ? '1px solid var(--dsw-alias-brand-primary)' : '1px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-layer-1)',
          boxShadow: '0 10px 28px rgba(15, 23, 42, 0.22)',
        },
      },
      h('span', {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 96,
          height: 128,
          borderRadius: 12,
          background: 'var(--dsw-alias-bg-layer-2)',
          overflow: 'hidden',
        },
      }, h(CanArt, { dim: todayCans === 0 || loading })),
      h('span', {
        style: {
          display: 'flex',
          alignItems: 'baseline',
          gap: 4,
          color: lineColor,
          fontSize: 13,
          lineHeight: '16px',
          fontWeight: 600,
        },
      },
      loading ? '…' : String(todayCans),
      h('span', {
        style: { color: secondary, fontSize: 11, fontWeight: 400 },
      }, t('today'))),
      h('span', {
        style: { color: secondary, fontSize: 10, lineHeight: '13px', whiteSpace: 'nowrap' },
      }, failed ? t('unavailable') : `${totalCans} ${t('total')}`),
      h('span', {
        'aria-hidden': true,
        style: {
          position: 'absolute',
          top: -8,
          right: -8,
          minWidth: 24,
          height: 24,
          boxSizing: 'border-box',
          padding: '0 6px',
          borderRadius: 12,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: '2px solid var(--dsw-alias-bg-layer-1)',
          background: failed ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-brand-primary)',
          color: '#fff',
          fontSize: 11,
          fontWeight: 700,
          lineHeight: 1,
        },
      }, badge))),
      open && popup !== null && h('div', {
        role: 'dialog',
        'aria-modal': 'false',
        'aria-label': t('last7Days'),
        style: {
          position: 'fixed',
          left: popup.x,
          top: popup.y,
          width: popup.width,
          zIndex: 9001,
          pointerEvents: 'auto',
          boxSizing: 'border-box',
          padding: 12,
          borderRadius: 14,
          border: '1px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-layer-1)',
          boxShadow: '0 14px 34px rgba(15, 23, 42, 0.28)',
          color: primary,
          maxHeight: 'calc(100vh - 20px)',
          overflow: 'auto',
        },
      },
      h('div', {
        style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 },
      },
      h('strong', { style: { fontSize: 13 } }, t('last7Days')),
      h('button', {
        type: 'button',
        ref: closeButtonRef,
        onClick: () => closePopup(true),
        'aria-label': t('close'),
        style: {
          border: 'none',
          background: 'transparent',
          color: secondary,
          cursor: 'pointer',
          font: 'inherit',
          fontSize: 18,
          lineHeight: 1,
          padding: '0 2px',
          borderRadius: 6,
        },
      }, '×')),
      chart,
      h('div', {
        style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 8 },
      },
      h('span', { style: { color: secondary, fontSize: 11 } }, `${t('weekTotal')}: ${weekTotal}`),
      h('button', {
        type: 'button',
        onClick: resetPosition,
        style: {
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'transparent',
          color: secondary,
          cursor: 'pointer',
          font: 'inherit',
          fontSize: 11,
          padding: '2px 7px',
          borderRadius: 6,
        },
      }, t('resetPosition')))))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(
          () => ctx.locale.register(NS, { en: dictionaries.en, zh: dictionaries.zh }),
          'monster-tracker: dictionaries',
        )
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'monster-tracker-float',
          order: 60,
          locale: NS,
        }, MonsterCan))
      },
    }
  },
})
