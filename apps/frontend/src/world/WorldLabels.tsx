import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { AgentView, Location, Role, RoleDefinition } from '../../../../packages/contracts';
import { roleDetails, zoneNames } from '../features/roles';
import { plannedZones, zonePositions } from './layout';
import { ZONE_GLOWS } from './geometry';

export type ProjectedLabels = Record<string, { left: number; top: number }>;
const TOOLTIP_HIDE_DELAY_MS = 140;

export function WorldLabels({ positions, roles, agents = [], selected, selectedLocation, onSelect, night }: {
  positions: ProjectedLabels;
  roles: RoleDefinition[];
  agents?: AgentView[];
  selected: Role;
  selectedLocation: Location;
  onSelect: (role: Role) => void;
  night: boolean;
}) {
  const [hoveredZone, setHoveredZone] = useState<Location | null>(null);
  const [focusedZone, setFocusedZone] = useState<Location | null>(null);
  const [tooltipSuppressed, setTooltipSuppressed] = useState(false);
  const [tooltipPosition, setTooltipPosition] = useState<{ left: number; top: number }>({ left: 12, top: 12 });
  const rootRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const hideTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tooltipSuppressedRef = useRef(false);
  const tooltipId = useId() + '-zone-tooltip';
  const activeZone = tooltipSuppressed ? null : hoveredZone ?? focusedZone;
  const activePosition = activeZone ? positions['zone.' + activeZone] : undefined;
  const tooltipVisible = Boolean(activeZone && activePosition);
  const rolesInZone = (zone: Location) => roles.filter(definition =>
    (agents.find(agent => agent.role === definition.role)?.location ?? definition.location) === zone);

  const cancelHide = useCallback(() => {
    if (hideTimeout.current !== null) {
      clearTimeout(hideTimeout.current);
      hideTimeout.current = null;
    }
  }, []);
  const revealTooltip = useCallback(() => {
    cancelHide();
    tooltipSuppressedRef.current = false;
    setTooltipSuppressed(false);
  }, [cancelHide]);
  const scheduleHide = useCallback((zone: Location) => {
    cancelHide();
    if (tooltipSuppressedRef.current) return;
    // Allow the pointer to cross the gap between a pin and its tooltip.
    hideTimeout.current = setTimeout(() => {
      hideTimeout.current = null;
      setHoveredZone(current => current === zone ? null : current);
    }, TOOLTIP_HIDE_DELAY_MS);
  }, [cancelHide]);

  useEffect(() => cancelHide, [cancelHide]);
  useEffect(() => {
    if (!tooltipVisible) return;
    const dismissTooltip = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || tooltipSuppressedRef.current) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cancelHide();
      tooltipSuppressedRef.current = true;
      setTooltipSuppressed(true);
      setHoveredZone(null);
    };
    window.addEventListener('keydown', dismissTooltip, true);
    return () => window.removeEventListener('keydown', dismissTooltip, true);
  }, [tooltipVisible, cancelHide]);

  useLayoutEffect(() => {
    const container = rootRef.current;
    const tooltip = tooltipRef.current;
    if (!container || !tooltip || !activePosition) return;
    const updatePosition = () => {
      const next = {
        left: Math.min(Math.max(12, activePosition.left + 16), Math.max(12, container.clientWidth - tooltip.offsetWidth - 12)),
        top: Math.min(Math.max(12, activePosition.top - tooltip.offsetHeight - 16), Math.max(12, container.clientHeight - tooltip.offsetHeight - 12)),
      };
      setTooltipPosition(previous => Math.abs(previous.left - next.left) < 0.1 && Math.abs(previous.top - next.top) < 0.1 ? previous : next);
    };
    updatePosition();
    const observer = new ResizeObserver(updatePosition);
    observer.observe(container);
    observer.observe(tooltip);
    return () => observer.disconnect();
  }, [activeZone, activePosition, roles, agents]);

  const selectedAnchor = positions['agent.' + selected];
  const zoneRoles = activeZone ? rolesInZone(activeZone) : [];

  return <div className="world-labels" ref={rootRef} data-theme={night ? 'dark' : 'light'}>
    {Object.keys(zonePositions).map(id => {
      const zone = id as Location;
      const position = positions['zone.' + zone];
      if (!position) return null;
      const members = rolesInZone(zone);
      const style: CSSProperties & { '--zone-glow': string } = { ...position, '--zone-glow': ZONE_GLOWS[zone] };
      return <button key={zone} type="button"
        className={'zone-pin world-label' + (selectedLocation === zone ? ' selected' : '') + (plannedZones.has(zone) ? ' planned' : '')}
        style={style} aria-label={'Осмотреть зону: ' + zoneNames[zone]}
        aria-describedby={activeZone === zone ? tooltipId : undefined} aria-pressed={selectedLocation === zone}
        onMouseEnter={() => { revealTooltip(); setHoveredZone(zone); }}
        onMouseLeave={() => scheduleHide(zone)}
        onFocus={() => { revealTooltip(); setFocusedZone(zone); }}
        onBlur={() => setFocusedZone(current => current === zone ? null : current)}
        onClick={() => {
          const definition = members.find(member => member.role === selected) ?? members[0];
          if (definition) onSelect(definition.role);
        }}>
        <span className="zone-pin-dot" aria-hidden="true" style={{ position: 'absolute' }} />
      </button>;
    })}

    {selectedAnchor && <span className="avatar-label world-label selected" style={{ ...selectedAnchor, pointerEvents: 'none' }}>
      {roleDetails[selected].short}
    </span>}

    {activeZone && activePosition && <div className="zone-tooltip" role="tooltip" id={tooltipId}
      ref={tooltipRef} style={tooltipPosition}
      onMouseEnter={() => {
        cancelHide();
        if (!tooltipSuppressedRef.current && activeZone) setHoveredZone(activeZone);
      }}
      onMouseLeave={() => { if (activeZone) scheduleHide(activeZone); }}>
      <div className="zone-tooltip-content">
        <span className="zone-tooltip-name">{zoneNames[activeZone]}</span>
        <span className="zone-tooltip-role">{zoneRoles.length
          ? zoneRoles.map(definition => roleDetails[definition.role].name).join(' · ')
          : activeZone === 'core' ? 'Центр фабрики' : 'Роль ещё не назначена'}</span>
        <span className="zone-tooltip-status">{plannedZones.has(activeZone) ? 'Планируется'
          : activeZone === 'core' ? 'Телеметрия недоступна'
          : zoneRoles.length ? 'Роли настроены' : 'Нет назначенной роли'}</span>
      </div>
    </div>}
  </div>;
}
