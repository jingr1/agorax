import { ArrowDown01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useCallback, useState } from 'react'
import { SaveModeDialog } from './save-mode-dialog'
import { ManageModesModal } from './manage-modes-modal'
import { ApplyModeDialog } from './apply-mode-dialog'
import type { Mode } from '@/hooks/use-modes'
import { useModes } from '@/hooks/use-modes'
import { cn } from '@/lib/utils'
import {
  MenuContent,
  MenuItem,
  MenuRoot,
  MenuTrigger,
} from '@/components/ui/menu'

type ModeSelectorProps = {
  currentModel: string
  onModelSwitch: (modelId: string) => void
  disabled?: boolean
  availableModels: Array<string>
  isStreaming?: boolean
}

export function ModeSelector({
  currentModel,
  onModelSwitch,
  disabled = false,
  availableModels,
  isStreaming = false,
}: ModeSelectorProps) {
  const [showSaveDialog, setShowSaveDialog] = useState(false)
  const [showManageModal, setShowManageModal] = useState(false)
  const [modeToApply, setModeToApply] = useState<Mode | null>(null)

  const {
    modes,
    appliedModeId,
    saveMode,
    applyMode,
    getAppliedMode,
    hasDrift,
  } = useModes()

  const appliedMode = getAppliedMode()
  const buttonLabel = appliedMode ? appliedMode.name : 'Mode'

  const handleApplyMode = useCallback(
    (mode: Mode) => {
      const needsModelSwitch =
        mode.preferredModel && mode.preferredModel !== currentModel
      const modelAvailable =
        mode.preferredModel && availableModels.includes(mode.preferredModel)

      if (needsModelSwitch && !modelAvailable) {
        applyMode(mode)
        return
      }

      if (needsModelSwitch && !isStreaming) {
        setModeToApply(mode)
        return
      }

      applyMode(mode)
    },
    [applyMode, currentModel, availableModels, isStreaming],
  )

  const handleConfirmApply = useCallback(
    (switchModel: boolean) => {
      if (!modeToApply) return
      applyMode(modeToApply)
      if (switchModel && modeToApply.preferredModel) {
        onModelSwitch(modeToApply.preferredModel)
      }
      setModeToApply(null)
    },
    [modeToApply, applyMode, onModelSwitch],
  )

  const handleSaveMode = useCallback(
    (name: string, includeModel: boolean) => {
      const result = saveMode(name, includeModel, currentModel)
      if (!('error' in result)) {
        setShowSaveDialog(false)
      }
      return result
    },
    [saveMode, currentModel],
  )

  const handleCloseSaveDialog = useCallback(() => {
    setShowSaveDialog(false)
  }, [])

  const showDrift = appliedMode && hasDrift(appliedMode.id)
  const modelUnavailable =
    appliedMode?.preferredModel &&
    !availableModels.includes(appliedMode.preferredModel)

  return (
    <>
      <MenuRoot>
        <MenuTrigger
          type="button"
          disabled={disabled}
          className={cn(
            'inline-flex h-8 items-center gap-1 rounded-full border border-primary-200 bg-primary-50 px-3 text-xs font-medium text-primary-700 transition-colors hover:bg-primary-100',
            disabled && 'cursor-not-allowed opacity-50',
          )}
          aria-label="Mode selector"
        >
          <span className="max-w-[8rem] truncate">{buttonLabel}</span>
          {showDrift ? (
            <span className="text-yellow-600" title="Settings changed">
              ⚠️
            </span>
          ) : null}
          {modelUnavailable ? (
            <span className="text-red-600" title="Model unavailable">
              ⚠️
            </span>
          ) : null}
          <HugeiconsIcon icon={ArrowDown01Icon} size={20} strokeWidth={1.5} />
        </MenuTrigger>
        <MenuContent
          side="top"
          align="start"
          className="min-w-[14rem] max-w-[20rem]"
        >
          <div className="max-h-[20rem] overflow-y-auto">
            {modes.length === 0 ? (
              <div className="p-4 text-center text-sm text-primary-500">
                No modes saved
              </div>
            ) : (
              modes.map((mode) => {
                const isApplied = appliedModeId === mode.id
                const drift = isApplied && hasDrift(mode.id)
                const unavailable =
                  mode.preferredModel &&
                  !availableModels.includes(mode.preferredModel)

                return (
                  <MenuItem
                    key={mode.id}
                    onClick={() => handleApplyMode(mode)}
                    className={cn(isApplied && 'bg-primary-100 text-primary-900')}
                    aria-label={`Apply mode ${mode.name}`}
                  >
                    <span className="flex-1 truncate">{mode.name}</span>
                    {drift ? (
                      <span
                        className="text-xs text-yellow-600"
                        title="Settings changed"
                      >
                        ⚠️
                      </span>
                    ) : null}
                    {unavailable ? (
                      <span
                        className="text-xs text-red-600"
                        title="Model unavailable"
                      >
                        ⚠️
                      </span>
                    ) : null}
                    {isApplied && !drift ? (
                      <span aria-label="Currently active">✓</span>
                    ) : null}
                  </MenuItem>
                )
              })
            )}

            <div className="my-1 border-t border-primary-200" />

            <MenuItem
              onClick={() => setShowSaveDialog(true)}
              aria-label="Save current settings as new mode"
            >
              Save Current as New Mode...
            </MenuItem>

            {modes.length > 0 ? (
              <MenuItem
                onClick={() => setShowManageModal(true)}
                aria-label="Manage modes"
              >
                Manage Modes...
              </MenuItem>
            ) : null}
          </div>
        </MenuContent>
      </MenuRoot>

      {showSaveDialog ? (
        <SaveModeDialog
          currentModel={currentModel}
          onSave={handleSaveMode}
          onClose={handleCloseSaveDialog}
        />
      ) : null}

      {showManageModal ? (
        <ManageModesModal
          onClose={() => setShowManageModal(false)}
          availableModels={availableModels}
        />
      ) : null}

      {modeToApply ? (
        <ApplyModeDialog
          mode={modeToApply}
          onConfirm={handleConfirmApply}
          onClose={() => setModeToApply(null)}
        />
      ) : null}
    </>
  )
}
