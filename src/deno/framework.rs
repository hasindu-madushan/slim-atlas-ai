/// Framework detection hints used to identify client-side rendering frameworks.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, rmcp::schemars::JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum FrameworkHint {
    NextSsr,
    NextCsr,
    ReactCsr,
    AngularUniv,
    AngularCsr,
    VueSsr,
    Static,
}
