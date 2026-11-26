using Xunit;

namespace Calc.Tests;

public class OtherTests
{
    [Fact]
    public void DividesTwoNumbers()
    {
        Assert.Equal(2, Calculator.Divide(6, 3));
    }
}
