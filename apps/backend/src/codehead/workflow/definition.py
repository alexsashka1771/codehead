"""Role definitions and compatibility versions for the Clinic Demo workflow."""

from codehead.contracts import QUALITY_WORKFLOW_VERSIONS, Location, Role, RoleDefinition
from codehead.contracts import WORKFLOW_VERSION as WORKFLOW_VERSION

CANDIDATE_WORKFLOW_VERSIONS = ("clinic-v2", *QUALITY_WORKFLOW_VERSIONS)
ROLE_DEFINITIONS = (
    RoleDefinition(
        role=Role.PRODUCT_MANAGER,
        name="Product Manager",
        location=Location.PRODUCT,
        appearance_id="product_manager_v1",
        instructions_version="foundation-v1",
    ),
    RoleDefinition(
        role=Role.ARCHITECT,
        name="Architect",
        location=Location.ARCHITECTURE,
        appearance_id="architect_v1",
        instructions_version="foundation-v1",
    ),
    RoleDefinition(
        role=Role.CTO,
        name="CTO",
        location=Location.MEETING,
        appearance_id="cto_v1",
        instructions_version="foundation-v1",
    ),
    RoleDefinition(
        role=Role.BACKEND,
        name="Backend Engineer",
        location=Location.DEVELOPMENT,
        appearance_id="backend_v1",
        instructions_version="foundation-v1",
    ),
    RoleDefinition(
        role=Role.FRONTEND,
        name="Frontend Engineer",
        location=Location.DEVELOPMENT,
        appearance_id="frontend_v1",
        instructions_version="foundation-v1",
    ),
    RoleDefinition(
        role=Role.QA,
        name="QA Engineer",
        location=Location.QA,
        appearance_id="qa_v1",
        instructions_version="foundation-v1",
    ),
    RoleDefinition(
        role=Role.DEVOPS,
        name="DevOps Engineer",
        location=Location.DEVOPS,
        appearance_id="devops_v1",
        instructions_version="foundation-v1",
    ),
)
DEPENDENCIES = {
    Role.PRODUCT_MANAGER: (),
    Role.ARCHITECT: (Role.PRODUCT_MANAGER,),
    Role.CTO: (Role.ARCHITECT,),
    Role.BACKEND: (Role.CTO,),
    Role.FRONTEND: (Role.CTO,),
    Role.QA: (Role.BACKEND, Role.FRONTEND),
    Role.DEVOPS: (Role.QA,),
}
TASK_TYPES = {
    Role.PRODUCT_MANAGER: "requirements",
    Role.ARCHITECT: "architecture",
    Role.CTO: "assessment",
    Role.BACKEND: "backend_implementation",
    Role.FRONTEND: "frontend_implementation",
    Role.QA: "quality_assurance",
    Role.DEVOPS: "build_and_preview",
}
ROLE_ORDER = {definition.role: index for index, definition in enumerate(ROLE_DEFINITIONS)}
