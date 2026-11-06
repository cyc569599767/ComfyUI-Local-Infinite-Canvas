import { channelModelOf, modelOptionName, workflowModelOptions, workflowModelValue, type AiConfig, type ModelCapability } from "@/stores/use-config-store";

/** Draft is created by its dedicated action, but its saved/active selection must
 * still appear in the picker. Compare the channel-qualified workflow value so
 * selecting one channel's draft does not expose another channel's draft entry.
 * Only configured options are shown; never invent or change a model selection.
 */
export function workflowPickerSelection(config: AiConfig, value: string, capability?: ModelCapability) {
    const selected = workflowModelValue(config, value) || value;
    const options = workflowModelOptions(config, capability).filter(model =>
        model === selected || (channelModelOf(config, model)?.model.workflowId || modelOptionName(model)) !== "video-h3-fast",
    );
    return { selected, options };
}
