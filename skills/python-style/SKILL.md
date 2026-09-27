---
name: python-style
description: Apply these typing, structure, and maintenance preferences when writing or editing Python code in a user's project.
---

# Python Style

Use these guidelines for Python code or features the user requests in a project. They do not apply to temporary, one-off Python scripts written only to help complete another task, unless the user requests the script as a deliverable.

## Types and data shapes

- **Use precise types.** Annotate function parameters, return values, and data exposed across module boundaries. Let the type checker infer obvious local types; annotate locals when inference hides an important constraint. Avoid `Any` unless an untyped third-party interface makes it unavoidable, and keep it at that boundary.
- **Keep accepted inputs narrow.** Avoid broad unions of unrelated shapes, such as `str | Model` or `dict | Config | None`. Convert inputs at the call site or at a defined boundary, then pass one concrete type through the rest of the code. Use a union when the alternatives are genuinely part of the domain, such as an optional value.
- **Do not repeatedly inspect known types at runtime.** Prefer typed interfaces to `isinstance` or `hasattr` branches in business logic. Validate untrusted data at entry points, where runtime checks have a clear purpose.
- **Model stable structures.** Use dataclasses for internal records and Pydantic models for validated configuration, persisted data, and API request or response objects. Avoid passing raw JSON-shaped dictionaries or positional tuples through code when their fields have stable meanings. Follow an established project model type when it already serves the same purpose.
- **Name fields explicitly.** New module interfaces should make expected data shapes clear from their signatures and model definitions, without relying on undocumented dictionary keys or tuple positions.

## Functions and layout

- Keep control-flow nesting to about three levels within a function. Use early returns or extract a well-named function when deeper nesting obscures the main path.
- Aim for functions of about 20 lines or fewer when that improves readability. A longer function is fine when it remains clear, such as a sequence of simple related actions. Do not split a cohesive operation solely to meet a line count.
- Add blank lines inside functions to separate meaningful stages. Keep related statements together; groups of roughly three to eight lines are a useful guide, not a formatting rule.
- Keep function signatures focused. Avoid speculative optional parameters or defaults that no current caller needs. If several arguments always travel together, consider a typed data model.

## Changes to existing code

- Check the project and its existing libraries before implementing a new helper. Reuse or extract shared code when the same behavior already exists. If a library nearly provides the behavior but needs a change outside the task's scope, discuss that change with the user before reimplementing the behavior.
- Unless the user requests backward compatibility, prefer a clean interface over retaining obsolete internal signatures, aliases, or compatibility branches. Update their callers as part of the change, and make any public interface changes clear.
- Remove code made unused by the change, especially obsolete internal helpers and call paths. Keep deletion tied to the work at hand.
